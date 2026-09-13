use super::{delta, key, Device, Frame, InputBackend};
use crate::game::VirtualGamepadBackend;
use std::collections::HashSet;
use vigem_rust::{Client, TargetHandle, X360Button, X360Report, Xbox360};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;

#[derive(Default)]
pub(super) struct KeyboardMouse {
    keys: HashSet<String>,
    buttons: u8,
}

fn send(input: INPUT) -> Result<(), String> {
    // SendInput aplica somente input do usuário; não tenta contornar UIPI ou elevar privilégios.
    if unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) } == 1 {
        Ok(())
    } else {
        Err(
            "Windows recusou o input. O jogo e o Risk precisam estar no mesmo nível de permissão."
                .into(),
        )
    }
}

fn keyboard(code: &str, pressed: bool) -> Result<(), String> {
    let scan = key(code).ok_or("Tecla não suportada")?.scan;
    send(INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: 0,
                wScan: scan & 0xff,
                dwFlags: KEYEVENTF_SCANCODE
                    | if scan > 0xff {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        0
                    }
                    | if pressed { 0 } else { KEYEVENTF_KEYUP },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}

fn mouse(flags: u32, dx: i32, dy: i32, data: u32) -> Result<(), String> {
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}

fn button(index: usize, pressed: bool) -> Result<(), String> {
    let flags = [
        (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP),
        (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP),
    ][index];
    mouse(
        if pressed { flags.0 } else { flags.1 },
        0,
        0,
        if index == 3 {
            1
        } else if index == 4 {
            2
        } else {
            0
        },
    )
}

impl InputBackend for KeyboardMouse {
    fn apply(&mut self, previous: &Frame, next: &Frame) -> Result<(), String> {
        for code in self.keys.clone() {
            if !next.keys.contains(&code) {
                keyboard(&code, false)?;
                self.keys.remove(&code);
            }
        }
        for code in &next.keys {
            if !self.keys.contains(code) {
                keyboard(code, true)?;
                self.keys.insert(code.clone());
            }
        }
        for index in 0..5 {
            let bit = 1 << index;
            if (self.buttons ^ next.buttons) & bit != 0 {
                button(index, next.buttons & bit != 0)?;
                self.buttons ^= bit;
            }
        }
        let (x, y) = (
            delta(previous.x, next.x, 2000),
            delta(previous.y, next.y, 2000),
        );
        if x != 0 || y != 0 {
            mouse(MOUSEEVENTF_MOVE, x, y, 0)?;
        }
        let wheel = -delta(previous.wheel, next.wheel, 1200);
        if wheel != 0 {
            mouse(MOUSEEVENTF_WHEEL, 0, 0, wheel as u32)?;
        }
        Ok(())
    }

    fn release_all(&mut self) -> Result<(), String> {
        let mut failure = None;
        for code in self.keys.clone() {
            match keyboard(&code, false) {
                Ok(()) => {
                    self.keys.remove(&code);
                }
                Err(e) => failure = Some(e),
            }
        }
        for index in 0..5 {
            let bit = 1 << index;
            if self.buttons & bit != 0 {
                match button(index, false) {
                    Ok(()) => self.buttons &= !bit,
                    Err(e) => failure = Some(e),
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

impl Drop for KeyboardMouse {
    fn drop(&mut self) {
        let _ = self.release_all();
    }
}

fn vigem_error(error: impl std::fmt::Display) -> String {
    format!("Controle virtual Windows indisponível: {error}")
}

pub(super) fn probe() -> Result<(), String> {
    Client::connect().map(|_| ()).map_err(vigem_error)
}

fn stick(value: f64) -> i16 {
    let value = value.clamp(-1.0, 1.0);
    if value >= 0.0 {
        (value * f64::from(i16::MAX)).round() as i16
    } else {
        (value * 32768.0).round() as i16
    }
}

fn trigger(value: f64) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn report_from_frame(frame: &Frame) -> X360Report {
    let Some(gamepad) = frame.gamepad.as_ref() else {
        return X360Report::default();
    };

    let mut buttons = X360Button::empty();
    let pressed = |index: usize| gamepad.buttons.get(index).copied().unwrap_or(0.0) > 0.5;
    for (index, flag) in [
        (0, X360Button::A),
        (1, X360Button::B),
        (2, X360Button::X),
        (3, X360Button::Y),
        (4, X360Button::LEFT_SHOULDER),
        (5, X360Button::RIGHT_SHOULDER),
        (8, X360Button::BACK),
        (9, X360Button::START),
        (10, X360Button::LEFT_THUMB),
        (11, X360Button::RIGHT_THUMB),
        (12, X360Button::DPAD_UP),
        (13, X360Button::DPAD_DOWN),
        (14, X360Button::DPAD_LEFT),
        (15, X360Button::DPAD_RIGHT),
        (16, X360Button::GUIDE),
    ] {
        if pressed(index) {
            buttons |= flag;
        }
    }

    let axis = |index: usize| gamepad.axes.get(index).copied().unwrap_or(0.0);
    let button_value = |index: usize| gamepad.buttons.get(index).copied().unwrap_or(0.0);

    X360Report {
        buttons,
        left_trigger: trigger(button_value(6)),
        right_trigger: trigger(button_value(7)),
        thumb_lx: stick(axis(0)),
        // Browser Gamepad API usa Y positivo para baixo; XInput usa positivo para cima.
        thumb_ly: stick(-axis(1)),
        thumb_rx: stick(axis(2)),
        thumb_ry: stick(-axis(3)),
    }
}

struct Gamepad {
    // O TargetHandle guarda Weak<Client>; manter o Client vivo mantém o alvo conectado ao bus.
    _client: Client,
    pad: TargetHandle<Xbox360>,
}

impl Gamepad {
    fn new() -> Result<Self, String> {
        let client = Client::connect().map_err(vigem_error)?;
        let pad = client
            .new_x360_target()
            .plug()
            .map_err(vigem_error)?
            .wait_for_ready()
            .map_err(vigem_error)?;
        Ok(Self {
            _client: client,
            pad,
        })
    }
}

impl VirtualGamepadBackend for Gamepad {}

impl InputBackend for Gamepad {
    fn apply(&mut self, _: &Frame, next: &Frame) -> Result<(), String> {
        self.pad
            .update(&report_from_frame(next))
            .map_err(vigem_error)
    }

    fn release_all(&mut self) -> Result<(), String> {
        self.pad.update(&X360Report::default()).map_err(vigem_error)
    }
}

pub(super) fn create(device: Device, _slot: usize) -> Result<Box<dyn InputBackend>, String> {
    if device == Device::Gamepad {
        let pad: Box<dyn VirtualGamepadBackend> = Box::new(Gamepad::new()?);
        Ok(pad)
    } else {
        Ok(Box::new(KeyboardMouse::default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::Pad;

    fn gamepad_frame(axes: [f64; 4], buttons: [f64; 17]) -> Frame {
        Frame {
            gamepad: Some(Pad {
                axes: axes.to_vec(),
                buttons: buttons.to_vec(),
            }),
            ..Frame::default()
        }
    }

    #[test]
    fn maps_standard_gamepad_to_xbox360_report() {
        let mut buttons = [0.0; 17];
        for index in [0, 4, 8, 9, 10, 12, 15, 16] {
            buttons[index] = 1.0;
        }
        buttons[6] = 0.5;
        buttons[7] = 1.0;

        let report = report_from_frame(&gamepad_frame([1.0, -1.0, -1.0, 1.0], buttons));
        let bits = report.buttons.bits();
        for expected in [
            0x1000, 0x0100, 0x0020, 0x0010, 0x0040, 0x0001, 0x0008, 0x0400,
        ] {
            assert_ne!(bits & expected, 0);
        }
        assert_eq!(report.left_trigger, 128);
        assert_eq!(report.right_trigger, 255);
        assert_eq!(report.thumb_lx, i16::MAX);
        assert_eq!(report.thumb_ly, i16::MAX);
        assert_eq!(report.thumb_rx, i16::MIN);
        assert_eq!(report.thumb_ry, i16::MIN);
    }

    #[test]
    fn missing_gamepad_frame_maps_to_neutral_report() {
        let report = report_from_frame(&Frame::default());
        assert_eq!(report.buttons.bits(), 0);
        assert_eq!(report.left_trigger, 0);
        assert_eq!(report.right_trigger, 0);
        assert_eq!(report.thumb_lx, 0);
        assert_eq!(report.thumb_ly, 0);
        assert_eq!(report.thumb_rx, 0);
        assert_eq!(report.thumb_ry, 0);
    }
}
