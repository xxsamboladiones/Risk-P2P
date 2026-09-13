use super::{delta, key, keys, Device, Frame, InputBackend};
use crate::game::VirtualGamepadBackend;
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::Write,
    os::fd::AsRawFd,
};

fn open() -> Result<File, String> {
    OpenOptions::new().write(true).open("/dev/uinput").map_err(|_| "Sem acesso a /dev/uinput. Habilite uinput e permita acesso ao seu usuário para hospedar o Modo Jogo.".into())
}
pub(super) fn probe() -> Result<(), String> {
    open().map(|_| ())
}
#[repr(C)]
struct InputId {
    bus: u16,
    vendor: u16,
    product: u16,
    version: u16,
}
#[repr(C)]
struct Setup {
    id: InputId,
    name: [u8; 80],
    ff_effects_max: u32,
}
#[repr(C)]
struct AbsInfo {
    value: i32,
    minimum: i32,
    maximum: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}
#[repr(C)]
struct AbsSetup {
    code: u16,
    info: AbsInfo,
}
#[repr(C)]
struct Event {
    time: libc::timeval,
    kind: u16,
    code: u16,
    value: i32,
}
struct Uinput(File);
impl Uinput {
    fn ioctl(&self, request: libc::c_ulong, value: libc::c_int) -> Result<(), String> {
        if unsafe { libc::ioctl(self.0.as_raw_fd(), request, value) } < 0 {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(())
        }
    }
    fn new(pad: bool, slot: usize) -> Result<Self, String> {
        let device = Self(open()?);
        device.ioctl(0x40045564, 1)?; // UI_SET_EVBIT(EV_KEY)
        if pad {
            for code in 304..=318 {
                device.ioctl(0x40045565, code)?;
            }
            device.ioctl(0x40045564, 3)?; // EV_ABS
            for code in [0, 1, 2, 3, 4, 5, 16, 17] {
                device.ioctl(0x40045567, code)?;
                let mut setup: AbsSetup = unsafe { std::mem::zeroed() };
                setup.code = code as u16;
                let hat = code >= 16;
                setup.info.minimum = if code == 2 || code == 5 {
                    0
                } else if hat {
                    -1
                } else {
                    -32768
                };
                setup.info.maximum = if hat { 1 } else { 32767 };
                if unsafe { libc::ioctl(device.0.as_raw_fd(), 0x401c5504 as libc::c_ulong, &setup) }
                    < 0
                {
                    return Err(std::io::Error::last_os_error().to_string());
                }
            }
        } else {
            for k in keys() {
                device.ioctl(0x40045565, k.linux as i32)?;
            }
            for code in 272..=276 {
                device.ioctl(0x40045565, code)?;
            }
            device.ioctl(0x40045564, 2)?; // EV_REL
            for code in [0, 1, 8] {
                device.ioctl(0x40045566, code)?;
            }
        }
        let mut setup: Setup = unsafe { std::mem::zeroed() };
        setup.id = InputId {
            bus: 3,
            vendor: 0x1209,
            product: if pad { 2 } else { 1 },
            version: 1,
        };
        let name = format!(
            "Risk {} {}",
            if pad {
                "Virtual Gamepad"
            } else {
                "Keyboard Mouse"
            },
            slot
        );
        setup.name[..name.len()].copy_from_slice(name.as_bytes());
        if unsafe { libc::ioctl(device.0.as_raw_fd(), 0x405c5503 as libc::c_ulong, &setup) } < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        device.ioctl(0x5501, 0)?; // UI_DEV_CREATE
        Ok(device)
    }
    fn emit(&mut self, kind: u16, code: u16, value: i32) -> Result<(), String> {
        let mut event: Event = unsafe { std::mem::zeroed() };
        event.kind = kind;
        event.code = code;
        event.value = value;
        let bytes = unsafe {
            std::slice::from_raw_parts(
                (&event as *const Event).cast::<u8>(),
                std::mem::size_of::<Event>(),
            )
        };
        self.0.write_all(bytes).map_err(|e| e.to_string())
    }
    fn sync(&mut self) -> Result<(), String> {
        self.emit(0, 0, 0)
    }
}
impl Drop for Uinput {
    fn drop(&mut self) {
        let _ = self.ioctl(0x5502, 0);
    }
}
struct KeyboardMouse {
    device: Uinput,
    keys: HashSet<String>,
    buttons: u8,
}
impl InputBackend for KeyboardMouse {
    fn apply(&mut self, previous: &Frame, next: &Frame) -> Result<(), String> {
        for code in self.keys.clone() {
            if !next.keys.contains(&code) {
                self.device.emit(1, key(&code).unwrap().linux, 0)?;
                self.keys.remove(&code);
            }
        }
        for code in &next.keys {
            if !self.keys.contains(code) {
                self.device.emit(1, key(code).unwrap().linux, 1)?;
                self.keys.insert(code.clone());
            }
        }
        for index in 0..5 {
            let bit = 1 << index;
            if (self.buttons ^ next.buttons) & bit != 0 {
                self.device
                    .emit(1, 272 + index, i32::from(next.buttons & bit != 0))?;
                self.buttons ^= bit;
            }
        }
        self.device.emit(2, 0, delta(previous.x, next.x, 2000))?;
        self.device.emit(2, 1, delta(previous.y, next.y, 2000))?;
        self.device
            .emit(2, 8, -delta(previous.wheel, next.wheel, 1200) / 120)?;
        self.device.sync()
    }
    fn release_all(&mut self) -> Result<(), String> {
        self.apply(&Frame::default(), &Frame::default())
    }
}
struct Gamepad {
    device: Uinput,
}
impl VirtualGamepadBackend for Gamepad {}
impl InputBackend for Gamepad {
    fn apply(&mut self, _: &Frame, next: &Frame) -> Result<(), String> {
        let axes = next
            .gamepad
            .as_ref()
            .map(|p| p.axes.as_slice())
            .unwrap_or(&[0.0; 4]);
        let buttons = next
            .gamepad
            .as_ref()
            .map(|p| p.buttons.as_slice())
            .unwrap_or(&[0.0; 17]);
        for (i, code) in [0, 1, 3, 4].into_iter().enumerate() {
            self.device.emit(3, code, (axes[i] * 32767.0) as i32)?;
        }
        for (i, code) in [304, 305, 307, 308, 310, 311, 312, 313, 314, 315, 317, 318]
            .into_iter()
            .enumerate()
        {
            self.device.emit(1, code, i32::from(buttons[i] > 0.5))?;
        }
        self.device.emit(1, 316, i32::from(buttons[16] > 0.5))?;
        self.device.emit(3, 2, (buttons[6] * 32767.0) as i32)?;
        self.device.emit(3, 5, (buttons[7] * 32767.0) as i32)?;
        self.device.emit(
            3,
            16,
            i32::from(buttons[15] > 0.5) - i32::from(buttons[14] > 0.5),
        )?;
        self.device.emit(
            3,
            17,
            i32::from(buttons[13] > 0.5) - i32::from(buttons[12] > 0.5),
        )?;
        self.device.sync()
    }
    fn release_all(&mut self) -> Result<(), String> {
        self.apply(&Frame::default(), &Frame::default())
    }
}
pub(super) fn create(device: Device, slot: usize) -> Result<Box<dyn InputBackend>, String> {
    let input = Uinput::new(device == Device::Gamepad, slot)?;
    if device == Device::Gamepad {
        let pad: Box<dyn VirtualGamepadBackend> = Box::new(Gamepad { device: input });
        Ok(pad)
    } else {
        Ok(Box::new(KeyboardMouse {
            device: input,
            keys: HashSet::new(),
            buttons: 0,
        }))
    }
}
