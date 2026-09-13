use super::{Device, Frame, InputBackend};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

#[derive(Deserialize)]
#[allow(dead_code)] // Cada plataforma usa somente seu código nativo da tabela compartilhada.
pub(super) struct Key {
    pub code: String,
    pub scan: u16,
    pub linux: u16,
}
pub(super) fn keys() -> &'static [Key] {
    static KEYS: OnceLock<Vec<Key>> = OnceLock::new();
    KEYS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/src/game-keys.json"
        ))
        .expect("mapa de teclas embutido")
    })
}
pub(super) fn key(code: &str) -> Option<&'static Key> {
    keys().iter().find(|k| k.code == code)
}
pub(super) fn capabilities() -> Value {
    #[cfg(windows)]
    {
        return match windows::probe() {
            Ok(()) => json!({"keyboardMouse": true, "gamepad": true}),
            Err(reason) => json!({"keyboardMouse": true, "gamepad": false, "reason": reason}),
        };
    }
    #[cfg(target_os = "linux")]
    {
        return match linux::probe() {
            Ok(()) => json!({"keyboardMouse": true, "gamepad": true}),
            Err(reason) => json!({"keyboardMouse": false, "gamepad": false, "reason": reason}),
        };
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        json!({"keyboardMouse": false, "gamepad": false, "reason": "Este sistema ainda não oferece input nativo."})
    }
}
pub(super) fn create(device: Device, slot: usize) -> Result<Box<dyn InputBackend>, String> {
    #[cfg(windows)]
    {
        return windows::create(device, slot);
    }
    #[cfg(target_os = "linux")]
    {
        return linux::create(device, slot);
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (device, slot);
        Err("Input nativo indisponível".into())
    }
}
pub(super) fn delta(previous: i64, next: i64, limit: i64) -> i32 {
    (next - previous).clamp(-limit, limit) as i32
}
