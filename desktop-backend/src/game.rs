mod native;
use crate::{bearer, ApiError, AppState};
use axum::{
    extract::State,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use uuid::Uuid;

pub(super) trait InputBackend: Send {
    fn apply(&mut self, previous: &Frame, next: &Frame) -> Result<(), String>;
    fn release_all(&mut self) -> Result<(), String>;
}
// Backends de gamepad permanecem substituíveis; não dependem de um driver Windows aposentado.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(super) trait VirtualGamepadBackend: InputBackend {}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pad {
    axes: Vec<f64>,
    buttons: Vec<f64>,
}
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Frame {
    version: u8,
    session_id: String,
    grant_id: String,
    sequence: u64,
    keys: Vec<String>,
    buttons: u8,
    x: i64,
    y: i64,
    wheel: i64,
    gamepad: Option<Pad>,
}
#[derive(Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Device {
    KeyboardMouse,
    Gamepad,
}
struct Player {
    grant_id: String,
    device: Device,
    slot: usize,
    last: Frame,
    sequence: Option<u64>,
    received: Instant,
    idle: bool,
    backend: Box<dyn InputBackend>,
}
impl Drop for Player {
    fn drop(&mut self) {
        let _ = self.backend.release_all();
    }
}
struct Session {
    id: String,
    owner: Uuid,
    heartbeat: Instant,
    players: HashMap<String, Player>,
}
impl Session {
    fn join(
        &mut self,
        peer_id: String,
        grant_id: String,
        device: Device,
        previous_grant_id: Option<String>,
        create: impl FnOnce(Device, usize) -> Result<Box<dyn InputBackend>, String>,
    ) -> Result<usize, String> {
        match (&previous_grant_id, self.players.get(&peer_id)) {
            (Some(grant), Some(player)) if &player.grant_id == grant && grant != &grant_id => {}
            (None, None) => {}
            _ => return Err("Concessão de jogo inválida".into()),
        }
        let slot = match device {
            Device::KeyboardMouse => {
                if self.players.values().any(|p| p.device == device) {
                    return Err("Teclado e mouse já estão em uso".into());
                }
                0
            }
            Device::Gamepad => (1..=4)
                .find(|slot| !self.players.values().any(|p| p.slot == *slot))
                .ok_or("Os quatro controles estão em uso")?,
        };
        let backend = create(device, slot)?;
        // Allocate first, so an unavailable target preserves the current device.
        // The engine mutex serializes replacement with input, revoke and stop.
        if let Some(previous) = self.players.get_mut(&peer_id) {
            previous.backend.release_all()?;
        }
        self.players.insert(
            peer_id,
            Player {
                grant_id,
                device,
                slot,
                backend,
                received: Instant::now(),
                idle: false,
                last: Frame::default(),
                sequence: None,
            },
        );

        Ok(slot)
    }
}
#[derive(Default)]
pub(crate) struct Engine {
    session: Option<Session>,
}
impl Engine {
    fn session(&mut self, id: &str, owner: Uuid) -> Result<&mut Session, String> {
        self.expire(Instant::now());
        self.session
            .as_mut()
            .filter(|s| s.id == id && s.owner == owner)
            .ok_or("Sessão de jogo encerrada".into())
    }
    fn expire(&mut self, now: Instant) {
        if self
            .session
            .as_ref()
            .is_some_and(|s| now.duration_since(s.heartbeat) > Duration::from_secs(5))
        {
            self.session = None;
        }
        if let Some(s) = self.session.as_mut() {
            // Solte entradas rapidamente, mas não destrua o controle virtual por uma oscilação curta.
            s.players.retain(|_, p| {
                let silence = now.saturating_duration_since(p.received);
                if silence > Duration::from_secs(10) {
                    return false;
                }
                if silence > Duration::from_millis(250) && !p.idle {
                    if p.backend.release_all().is_err() {
                        return false;
                    }
                    p.last.keys.clear();
                    p.last.buttons = 0;
                    p.last.gamepad = None;
                    p.idle = true;
                }
                true
            });
        }
    }
    fn input(&mut self, owner: Uuid, peer: &str, frame: Frame) -> Result<(), String> {
        validate_frame(&frame)?;
        let s = self.session(&frame.session_id, owner)?;
        let p = s
            .players
            .get_mut(peer)
            .filter(|p| p.grant_id == frame.grant_id)
            .ok_or("Jogador sem acesso".to_string())?;
        if p.sequence.is_some_and(|seq| frame.sequence <= seq) {
            return Ok(());
        }
        if (p.device == Device::Gamepad
            && (!frame.keys.is_empty()
                || frame.buttons != 0
                || frame.x != 0
                || frame.y != 0
                || frame.wheel != 0))
            || (p.device == Device::KeyboardMouse && frame.gamepad.is_some())
        {
            return Err("Dispositivo não autorizado".into());
        }
        if p.idle {
            // Não reproduza movimento acumulado enquanto a entrada estava suspensa.
            p.last.x = frame.x;
            p.last.y = frame.y;
            p.last.wheel = frame.wheel;
        }
        if let Err(error) = p.backend.apply(&p.last, &frame) {
            s.players.remove(peer); // Drop também libera qualquer entrada parcialmente aplicada.
            return Err(error);
        }
        p.sequence = Some(frame.sequence);
        p.last = frame;
        p.received = Instant::now();
        p.idle = false;
        Ok(())
    }
}
fn valid_id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn validate_frame(f: &Frame) -> Result<(), String> {
    if f.version != 1
        || !valid_id(&f.session_id)
        || !valid_id(&f.grant_id)
        || f.sequence > 9_007_199_254_740_991
        || f.keys.len() > 64
        || f.keys.iter().collect::<HashSet<_>>().len() != f.keys.len()
        || f.keys.iter().any(|k| native::key(k).is_none())
        || f.buttons > 31
        || [f.x, f.y, f.wheel]
            .iter()
            .any(|v| !(-1_000_000_000..=1_000_000_000).contains(v))
    {
        return Err("Entrada de jogo inválida".into());
    }
    if let Some(p) = &f.gamepad {
        if p.axes.len() != 4
            || p.buttons.len() != 17
            || p.axes.iter().any(|n| !n.is_finite() || n.abs() > 1.0)
            || p.buttons
                .iter()
                .any(|n| !n.is_finite() || !(0.0..=1.0).contains(n))
        {
            return Err("Controle inválido".into());
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    Start {
        session_id: String,
    },
    Stop {
        session_id: String,
    },
    Heartbeat {
        session_id: String,
    },
    Join {
        session_id: String,
        peer_id: String,
        grant_id: String,
        device: Device,
        previous_grant_id: Option<String>,
    },
    Revoke {
        session_id: String,
        peer_id: String,
        grant_id: String,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    peer_id: String,
    frame: Frame,
}
pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/game/capabilities", get(capabilities))
        .route("/game/command", post(command))
        .route("/game/input", post(input))
        .route("/game/emergency-stop", post(emergency_stop))
        .layer(tower_http::limit::RequestBodyLimitLayer::new(4096))
}
async fn capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    bearer(&headers, &state)?;
    Ok(Json(native::capabilities()))
}
async fn emergency_stop(State(state): State<AppState>) -> Json<Value> {
    state.game.lock().await.session = None;
    Json(json!({"ok": true}))
}
async fn command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(cmd): Json<Command>,
) -> Result<Json<Value>, ApiError> {
    let owner = bearer(&headers, &state)?;
    let mut engine = state.game.lock().await;
    let result: Result<Value, String> = (|| match cmd {
        Command::Start { session_id } => {
            if !valid_id(&session_id) {
                return Err("Sessão inválida".into());
            }
            let caps = native::capabilities();
            if caps["keyboardMouse"] != true {
                return Err(caps["reason"]
                    .as_str()
                    .unwrap_or("Input nativo indisponível")
                    .into());
            }
            engine.session = Some(Session {
                id: session_id,
                owner,
                heartbeat: Instant::now(),
                players: HashMap::new(),
            });
            Ok(caps)
        }
        Command::Stop { session_id } => {
            if engine
                .session
                .as_ref()
                .is_some_and(|s| s.id == session_id && s.owner == owner)
            {
                engine.session = None;
            }
            Ok(json!({"ok": true}))
        }
        Command::Heartbeat { session_id } => {
            let s = engine.session(&session_id, owner)?;
            s.heartbeat = Instant::now();
            Ok(
                json!({"players": s.players.values().map(|p| p.grant_id.clone()).collect::<Vec<_>>()}),
            )
        }
        Command::Revoke {
            session_id,
            peer_id,
            grant_id,
        } => {
            let s = engine.session(&session_id, owner)?;
            if s.players
                .get(&peer_id)
                .is_some_and(|p| p.grant_id == grant_id)
            {
                s.players.remove(&peer_id);
            }
            Ok(json!({"ok": true}))
        }
        Command::Join {
            session_id,
            peer_id,
            grant_id,
            device,
            previous_grant_id,
        } => {
            if !valid_id(&peer_id) || !valid_id(&grant_id) {
                return Err("Jogador inválido".into());
            }
            let s = engine.session(&session_id, owner)?;
            let slot = s.join(peer_id, grant_id, device, previous_grant_id, native::create)?;
            Ok(json!({"slot": slot}))
        }
    })();
    result.map(Json).map_err(ApiError::Bad)
}
async fn input(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Input>,
) -> Result<Json<Value>, ApiError> {
    let owner = bearer(&headers, &state)?;
    state
        .game
        .lock()
        .await
        .input(owner, &input.peer_id, input.frame)
        .map_err(ApiError::Bad)?;
    Ok(Json(json!({"ok": true})))
}
pub(crate) fn watchdog(engine: Arc<Mutex<Engine>>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        loop {
            interval.tick().await;
            engine.lock().await.expire(Instant::now());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    #[derive(Default)]
    struct Observed {
        frames: Vec<Frame>,
        releases: usize,
    }
    struct Fake(Arc<StdMutex<Observed>>);
    impl InputBackend for Fake {
        fn apply(&mut self, _: &Frame, next: &Frame) -> Result<(), String> {
            self.0.lock().unwrap().frames.push(next.clone());
            Ok(())
        }
        fn release_all(&mut self) -> Result<(), String> {
            self.0.lock().unwrap().releases += 1;
            Ok(())
        }
    }
    fn setup() -> (Engine, Uuid, Arc<StdMutex<Observed>>) {
        let owner = Uuid::new_v4();
        let seen = Arc::new(StdMutex::new(Observed::default()));
        let player = Player {
            grant_id: "grant".into(),
            device: Device::KeyboardMouse,
            slot: 0,
            last: Frame::default(),
            sequence: None,
            received: Instant::now(),
            idle: false,
            backend: Box::new(Fake(seen.clone())),
        };
        let engine = Engine {
            session: Some(Session {
                id: "session".into(),
                owner,
                heartbeat: Instant::now(),
                players: HashMap::from([("peer".into(), player)]),
            }),
        };
        (engine, owner, seen)
    }
    fn frame(sequence: u64) -> Frame {
        Frame {
            version: 1,
            session_id: "session".into(),
            grant_id: "grant".into(),
            sequence,
            keys: vec!["KeyW".into()],
            ..Frame::default()
        }
    }
    #[test]
    fn switching_preserves_old_grant_on_allocation_failure_and_rejects_stale_input() {
        let (mut e, owner, seen) = setup();
        e.input(owner, "peer", frame(0)).unwrap();
        let s = e.session.as_mut().unwrap();
        assert!(s
            .join(
                "peer".into(),
                "new".into(),
                Device::Gamepad,
                Some("grant".into()),
                |_, _| Err("unavailable".into())
            )
            .is_err());
        assert_eq!(s.players["peer"].grant_id, "grant");
        assert_eq!(seen.lock().unwrap().releases, 0);
        let next = Arc::new(StdMutex::new(Observed::default()));
        assert_eq!(
            s.join(
                "peer".into(),
                "new".into(),
                Device::Gamepad,
                Some("grant".into()),
                |_, _| Ok(Box::new(Fake(next.clone())))
            )
            .unwrap(),
            1
        );
        assert!(seen.lock().unwrap().releases > 0);
        assert!(e.input(owner, "peer", frame(1)).is_err());
        assert_eq!(e.session.as_ref().unwrap().players["peer"].grant_id, "new");
    }
    #[test]
    fn switching_requires_existing_grant_and_preserves_busy_target() {
        let (mut e, _, _) = setup();
        let s = e.session.as_mut().unwrap();
        assert!(s
            .join(
                "peer".into(),
                "new".into(),
                Device::Gamepad,
                Some("stale".into()),
                |_, _| panic!("must not allocate")
            )
            .is_err());
        s.join(
            "other".into(),
            "other-grant".into(),
            Device::Gamepad,
            None,
            |_, _| Ok(Box::new(Fake(Arc::default()))),
        )
        .unwrap();
        assert!(s
            .join(
                "other".into(),
                "new".into(),
                Device::KeyboardMouse,
                Some("other-grant".into()),
                |_, _| panic!("busy target must not allocate")
            )
            .is_err());
        assert_eq!(s.players["other"].grant_id, "other-grant");
        s.players.remove("other");
        assert!(s
            .join(
                "other".into(),
                "new".into(),
                Device::Gamepad,
                Some("other-grant".into()),
                |_, _| panic!("revoked grant must not allocate")
            )
            .is_err());
    }
    #[test]
    fn rejects_old_packets_and_recovers_a_lost_keyup_with_the_next_snapshot() {
        let (mut e, owner, seen) = setup();
        e.input(owner, "peer", frame(2)).unwrap();
        let released = Frame {
            keys: vec![],
            ..frame(4)
        };
        e.input(owner, "peer", released).unwrap();
        e.input(owner, "peer", frame(3)).unwrap();
        e.input(owner, "peer", frame(4)).unwrap();
        let read = seen.lock().unwrap();
        assert_eq!(read.frames.len(), 2);
        assert!(read.frames[1].keys.is_empty());
    }
    #[test]
    fn rejects_wrong_user_peer_session_grant_and_device() {
        let (mut e, owner, seen) = setup();
        assert!(e.input(Uuid::new_v4(), "peer", frame(0)).is_err());
        assert!(e.input(owner, "stranger", frame(0)).is_err());
        assert!(e
            .input(
                owner,
                "peer",
                Frame {
                    session_id: "old".into(),
                    ..frame(0)
                }
            )
            .is_err());
        assert!(e
            .input(
                owner,
                "peer",
                Frame {
                    grant_id: "old".into(),
                    ..frame(0)
                }
            )
            .is_err());
        assert!(e
            .input(
                owner,
                "peer",
                Frame {
                    gamepad: Some(Pad {
                        axes: vec![0.0; 4],
                        buttons: vec![0.0; 17]
                    }),
                    ..frame(0)
                }
            )
            .is_err());
        assert!(seen.lock().unwrap().frames.is_empty());
    }
    #[test]
    fn revocation_timeout_and_session_stop_release_pressed_inputs() {
        for reason in ["revoke", "input-timeout", "host-timeout", "stop"] {
            let (mut e, owner, seen) = setup();
            e.input(owner, "peer", frame(0)).unwrap();
            match reason {
                "revoke" => {
                    e.session.as_mut().unwrap().players.remove("peer");
                }
                "input-timeout" => {
                    e.session
                        .as_mut()
                        .unwrap()
                        .players
                        .get_mut("peer")
                        .unwrap()
                        .received -= Duration::from_secs(11);
                    e.expire(Instant::now());
                }
                "host-timeout" => e.expire(Instant::now() + Duration::from_secs(6)),
                _ => e.session = None,
            }
            assert_eq!(seen.lock().unwrap().releases, 1, "{reason}");
            assert!(e.input(owner, "peer", frame(1)).is_err());
        }
    }
    #[test]
    fn brief_input_gap_releases_buttons_without_revoking_the_player() {
        let (mut e, owner, seen) = setup();
        e.input(owner, "peer", frame(0)).unwrap();
        e.expire(Instant::now() + Duration::from_millis(300));
        let releases = seen.lock().unwrap().releases;
        assert_eq!(releases, 1);
        assert!(e.session.as_ref().unwrap().players.contains_key("peer"));
        e.expire(Instant::now() + Duration::from_millis(1500));
        assert_eq!(seen.lock().unwrap().releases, 1);
        e.input(owner, "peer", frame(1)).unwrap();
        assert_eq!(seen.lock().unwrap().frames.len(), 2);
    }
    #[test]
    fn validates_untrusted_input_before_native_injection() {
        assert!(validate_frame(&Frame {
            keys: vec!["Shell".into()],
            ..frame(0)
        })
        .is_err());
        assert!(validate_frame(&Frame {
            x: i64::MIN,
            ..frame(0)
        })
        .is_err());
        assert!(validate_frame(&Frame {
            gamepad: Some(Pad {
                axes: vec![f64::NAN; 4],
                buttons: vec![0.0; 17]
            }),
            ..frame(0)
        })
        .is_err());
        assert!(validate_frame(&frame(0)).is_ok());
        assert_eq!(native::delta(10, 21, 2000), 11);
        assert_eq!(native::delta(0, 1_000_000, 2000), 2000);
    }
}
