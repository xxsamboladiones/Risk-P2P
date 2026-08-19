use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::OnceLock, time::Duration};
use tokio::{process::{Child, Command}, sync::Mutex, task::JoinHandle};

use super::super::AppState;

const MIX_SINK_NAME: &str = "risk.screen-share.mix";
const MIX_SOURCE_NAME: &str = "risk.screen-share.source";
const MIX_SOURCE_LABEL: &str = "Risk Screen Share Audio";
const RISK_APPLICATION_ID: &str = "com.risk.calls";
const RECONCILE_INTERVAL: Duration = Duration::from_millis(750);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareInput {
    #[serde(default = "default_exclude_risk")]
    exclude_risk: bool,
}

fn default_exclude_risk() -> bool { true }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareResponse {
    mode: &'static str,
    source_name: Option<&'static str>,
    source_label: Option<&'static str>,
    excluded_risk: bool,
    reason: Option<String>,
}

struct PipeWireSession {
    loopback: Child,
    reconcile_task: JoinHandle<()>,
}

static SESSION: OnceLock<Mutex<Option<PipeWireSession>>> = OnceLock::new();

fn session() -> &'static Mutex<Option<PipeWireSession>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/screen-audio/prepare", post(prepare))
        .route("/screen-audio/stop", post(stop))
}

async fn prepare(Json(input): Json<PrepareInput>) -> Json<PrepareResponse> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = input;
        return Json(PrepareResponse {
            mode: "display",
            source_name: None,
            source_label: None,
            excluded_risk: false,
            reason: None,
        });
    }

    #[cfg(target_os = "linux")]
    {
        match start_pipewire(input.exclude_risk).await {
            Ok(()) => Json(PrepareResponse {
                mode: "pipewire",
                source_name: Some(MIX_SOURCE_NAME),
                source_label: Some(MIX_SOURCE_LABEL),
                excluded_risk: input.exclude_risk,
                reason: None,
            }),
            Err(error) => {
                tracing::warn!(error = %error, "PipeWire screen audio unavailable");
                Json(PrepareResponse {
                    mode: "unavailable",
                    source_name: None,
                    source_label: None,
                    excluded_risk: false,
                    reason: Some(error.to_string()),
                })
            }
        }
    }
}

async fn stop() -> Json<Value> {
    stop_pipewire().await;
    Json(serde_json::json!({ "ok": true }))
}

#[cfg(target_os = "linux")]
async fn start_pipewire(exclude_risk: bool) -> anyhow::Result<()> {
    stop_pipewire().await;
    for command in ["pw-loopback", "pw-dump", "pw-link"] {
        ensure_command(command).await?;
    }

    let capture_props = serde_json::json!({
        "node.name": MIX_SINK_NAME,
        "node.description": "Risk Screen Share Mix",
        "media.class": "Audio/Sink",
        "audio.position": ["FL", "FR"],
        "node.autoconnect": false,
        "node.virtual": true
    });
    let playback_props = serde_json::json!({
        "node.name": MIX_SOURCE_NAME,
        "node.description": MIX_SOURCE_LABEL,
        "media.class": "Audio/Source",
        "audio.position": ["FL", "FR"],
        "node.autoconnect": false,
        "node.virtual": true,
        "node.passive": true
    });

    let mut command = Command::new("pw-loopback");
    command
        .arg(format!("--name={MIX_SOURCE_LABEL}"))
        .arg("--channels=2")
        .arg(format!("--capture-props={capture_props}"))
        .arg(format!("--playback-props={playback_props}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_parent_death_signal(&mut command)?;
    let mut child = command.spawn()?;

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    tracing::debug!(message = %line, "pw-loopback");
                }
            }
        });
    }

    wait_for_mix_nodes().await?;
    let risk_root_pid = parent_pid(std::process::id()).unwrap_or(std::process::id());
    reconcile_links(exclude_risk, risk_root_pid).await?;

    let reconcile_task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RECONCILE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(error) = reconcile_links(exclude_risk, risk_root_pid).await {
                tracing::debug!(error = %error, "PipeWire screen audio link reconciliation failed");
            }
        }
    });

    *session().lock().await = Some(PipeWireSession { loopback: child, reconcile_task });
    tracing::info!(exclude_risk, risk_root_pid, source = MIX_SOURCE_NAME, "PipeWire screen audio active");
    Ok(())
}

async fn stop_pipewire() {
    let current = session().lock().await.take();
    if let Some(mut current) = current {
        current.reconcile_task.abort();
        let _ = current.loopback.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), current.loopback.wait()).await;
        tracing::info!("PipeWire screen audio stopped");
    }
}

#[cfg(target_os = "linux")]
async fn ensure_command(command: &str) -> anyhow::Result<()> {
    let status = Command::new(command)
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| anyhow::anyhow!("{command} não está disponível: {error}"))?;
    if !status.success() {
        anyhow::bail!("{command} está instalado, mas não pôde ser executado");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn wait_for_mix_nodes() -> anyhow::Result<()> {
    for _ in 0..40 {
        let graph = read_graph().await?;
        let has_sink = graph.iter().any(|object| node_name(object) == Some(MIX_SINK_NAME));
        let has_source = graph.iter().any(|object| node_name(object) == Some(MIX_SOURCE_NAME));
        if has_sink && has_source { return Ok(()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("PipeWire não publicou a fonte virtual do Risk dentro do tempo esperado")
}

#[cfg(target_os = "linux")]
async fn read_graph() -> anyhow::Result<Vec<PwObject>> {
    let output = Command::new("pw-dump")
        .arg("-N")
        .stdin(Stdio::null())
        .output()
        .await?;
    if !output.status.success() {
        anyhow::bail!("pw-dump falhou: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[cfg(target_os = "linux")]
async fn reconcile_links(exclude_risk: bool, risk_root_pid: u32) -> anyhow::Result<()> {
    let graph = read_graph().await?;
    let nodes: HashMap<u32, &PwObject> = graph
        .iter()
        .filter(|object| object.type_name().ends_with(":Node"))
        .filter_map(|object| Some((object.id?, object)))
        .collect();
    let sink_id = nodes
        .iter()
        .find_map(|(id, object)| (node_name(object) == Some(MIX_SINK_NAME)).then_some(*id))
        .ok_or_else(|| anyhow::anyhow!("sink virtual do Risk não está no grafo PipeWire"))?;

    let sink_ports: Vec<&PwObject> = graph
        .iter()
        .filter(|object| object.type_name().ends_with(":Port"))
        .filter(|object| object.prop_u32("node.id") == Some(sink_id))
        .filter(|object| object.prop_str("port.direction") == Some("in"))
        .collect();
    if sink_ports.is_empty() {
        anyhow::bail!("sink virtual do Risk não publicou portas de entrada");
    }

    let mut playback_ports: HashMap<u32, Vec<&PwObject>> = HashMap::new();
    for object in &graph {
        if !object.type_name().ends_with(":Port") || object.prop_str("port.direction") != Some("out") {
            continue;
        }
        let Some(node_id) = object.prop_u32("node.id") else { continue; };
        let Some(node) = nodes.get(&node_id) else { continue; };
        if !is_playback_stream(node) || node_id == sink_id { continue; }
        if exclude_risk && is_risk_node(node, risk_root_pid) {
            tracing::trace!(node_id, name = ?node_name(node), "excluding Risk playback node from screen audio");
            continue;
        }
        playback_ports.entry(node_id).or_default().push(object);
    }

    for ports in playback_ports.values() {
        for (index, output) in ports.iter().enumerate() {
            let Some(output_id) = output.id else { continue; };
            let targets = matching_sink_ports(output, index, &sink_ports);
            for input in targets {
                let Some(input_id) = input.id else { continue; };
                let status = Command::new("pw-link")
                    .arg(output_id.to_string())
                    .arg(input_id.to_string())
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await;
                if let Ok(status) = status {
                    if status.success() {
                        tracing::trace!(output_id, input_id, "linked PipeWire playback into Risk screen mix");
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn matching_sink_ports<'a>(output: &PwObject, index: usize, sink_ports: &'a [&PwObject]) -> Vec<&'a PwObject> {
    let channel = output.prop_str("audio.channel");
    if channel == Some("MONO") {
        return sink_ports.iter().copied().take(2).collect();
    }
    if let Some(channel) = channel {
        if let Some(port) = sink_ports.iter().copied().find(|port| port.prop_str("audio.channel") == Some(channel)) {
            return vec![port];
        }
    }
    sink_ports.get(index.min(sink_ports.len().saturating_sub(1))).copied().into_iter().collect()
}

#[derive(Debug, Deserialize)]
struct PwObject {
    id: Option<u32>,
    #[serde(rename = "type")]
    object_type: Option<String>,
    info: Option<PwInfo>,
}

#[derive(Debug, Deserialize)]
struct PwInfo {
    props: Option<HashMap<String, Value>>,
}

impl PwObject {
    fn type_name(&self) -> &str { self.object_type.as_deref().unwrap_or("") }
    fn prop(&self, key: &str) -> Option<&Value> { self.info.as_ref()?.props.as_ref()?.get(key) }
    fn prop_str(&self, key: &str) -> Option<&str> { self.prop(key)?.as_str() }
    fn prop_u32(&self, key: &str) -> Option<u32> {
        match self.prop(key)? {
            Value::Number(number) => number.as_u64().and_then(|value| u32::try_from(value).ok()),
            Value::String(value) => value.parse().ok(),
            _ => None,
        }
    }
}

fn node_name(object: &PwObject) -> Option<&str> { object.prop_str("node.name") }

fn is_playback_stream(object: &PwObject) -> bool {
    matches!(object.prop_str("media.class"), Some("Stream/Output/Audio"))
        || matches!(object.prop_str("media.category"), Some("Playback"))
}

#[cfg(target_os = "linux")]
fn is_risk_node(object: &PwObject, risk_root_pid: u32) -> bool {
    if object.prop_str("application.id") == Some(RISK_APPLICATION_ID) { return true; }
    let application_name = object.prop_str("application.name").unwrap_or("").trim();
    if application_name.eq_ignore_ascii_case("risk") || application_name.to_ascii_lowercase().starts_with("risk ") {
        return true;
    }
    let name = node_name(object).unwrap_or("");
    if name == MIX_SINK_NAME || name == MIX_SOURCE_NAME { return true; }
    for key in ["application.process.id", "pipewire.sec.pid"] {
        if let Some(pid) = object.prop_u32(key) {
            if is_descendant_or_self(pid, risk_root_pid) { return true; }
        }
    }
    false
}

#[cfg(target_os = "linux")]
fn is_descendant_or_self(mut pid: u32, root: u32) -> bool {
    for _ in 0..48 {
        if pid == root { return true; }
        if pid <= 1 { return false; }
        let Some(parent) = parent_pid(pid) else { return false; };
        if parent == pid { return false; }
        pid = parent;
    }
    false
}

#[cfg(target_os = "linux")]
fn parent_pid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(PathBuf::from("/proc").join(pid.to_string()).join("stat")).ok()?;
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    fields.get(1)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn configure_parent_death_signal(command: &mut Command) -> anyhow::Result<()> {
    use std::os::unix::process::CommandExt;
    const PR_SET_PDEATHSIG: i32 = 1;
    const SIGTERM: i32 = 15;
    unsafe extern "C" {
        fn prctl(option: i32, arg2: usize, arg3: usize, arg4: usize, arg5: usize) -> i32;
    }
    unsafe {
        command.as_std_mut().pre_exec(|| {
            if prctl(PR_SET_PDEATHSIG, SIGTERM as usize, 0, 0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(props: Value) -> PwObject {
        PwObject {
            id: Some(10),
            object_type: Some("PipeWire:Interface:Node".into()),
            info: Some(PwInfo { props: Some(serde_json::from_value(props).unwrap()) }),
        }
    }

    #[test]
    fn detects_playback_streams() {
        assert!(is_playback_stream(&node(serde_json::json!({ "media.class": "Stream/Output/Audio" }))));
        assert!(!is_playback_stream(&node(serde_json::json!({ "media.class": "Audio/Source" }))));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn excludes_tagged_risk_application() {
        let object = node(serde_json::json!({
            "media.class": "Stream/Output/Audio",
            "application.id": RISK_APPLICATION_ID,
        }));
        assert!(is_risk_node(&object, u32::MAX));
    }
}
