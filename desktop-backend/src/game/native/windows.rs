use super::{delta, key, Frame, InputBackend};
use std::collections::HashSet;
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
