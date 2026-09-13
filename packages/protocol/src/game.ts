import keyMap from "./game-keys.json";

export const GAME_INPUT_CHANNEL = "risk.game-input.v1";
export const MAX_GAME_PACKET_BYTES = 4096;
export const GAME_KEYS = new Set(keyMap.map((key) => key.code));
export type GameDevice = "keyboard-mouse" | "gamepad";
export type GamepadState = { axes: number[]; buttons: number[] };
export type GameInputFrame = {
  version: 1; sessionId: string; grantId: string; sequence: number;
  keys: string[]; buttons: number; x: number; y: number; wheel: number;
  gamepad?: GamepadState;
};
export type GameControl =
  | { type: "game-sync"; sessionId: string }
  | { type: "game-mode-start"; sessionId: string; screenStreamId: string; gamepad: boolean; reason?: string }
  | { type: "game-mode-stop"; sessionId: string }
  | { type: "join-request"; sessionId: string; requestId: string; device: GameDevice; previousGrantId?: string }
  | { type: "join-accepted"; sessionId: string; requestId: string; grantId: string; device: GameDevice; slot: number }
  | { type: "join-rejected"; sessionId: string; requestId: string; reason: string }
  | { type: "leave"; sessionId: string; grantId: string }
  | { type: "revoked"; sessionId: string; grantId: string };
const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
const integer = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const coordinate = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= 1e9;
export function parseGameControl(raw: string): GameControl | null {
  if (raw.length > MAX_GAME_PACKET_BYTES) return null;
  try {
    const e = JSON.parse(raw);
    if (e?.version !== 1 || e?.namespace !== "risk.game" || !id(e.sessionId)) return null;
    switch (e.type) {
      case "game-mode-start": return id(e.screenStreamId) && typeof e.gamepad === "boolean" && (e.reason === undefined || (typeof e.reason === "string" && e.reason.length <= 160)) ? e : null;
      case "game-mode-stop": case "game-sync": return e;
      case "join-request": return id(e.requestId) && (e.previousGrantId === undefined || id(e.previousGrantId)) && ["keyboard-mouse", "gamepad"].includes(e.device) ? e : null;
      case "join-accepted": return id(e.requestId) && id(e.grantId) && ["keyboard-mouse", "gamepad"].includes(e.device) && integer(e.slot, 4) ? e : null;
      case "join-rejected": return id(e.requestId) && typeof e.reason === "string" && e.reason.length <= 160 ? e : null;
      case "leave": case "revoked": return id(e.grantId) ? e : null;
      default: return null;
    }
  } catch { return null; }
}
export function encodeGameControl(message: GameControl): string {
  return JSON.stringify({ version: 1, namespace: "risk.game", ...message });
}
export function parseGameInput(raw: string): GameInputFrame | null {
  if (raw.length > MAX_GAME_PACKET_BYTES) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.version !== 1 || !id(v.sessionId) || !id(v.grantId) || !integer(v.sequence, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(v.keys) || v.keys.length > 64 || !v.keys.every((k: unknown) => typeof k === "string" && GAME_KEYS.has(k))
      || new Set(v.keys).size !== v.keys.length || !integer(v.buttons, 31) || !coordinate(v.x) || !coordinate(v.y) || !coordinate(v.wheel)) return null;
    if (v.gamepad !== undefined && (!v.gamepad || !Array.isArray(v.gamepad.axes) || v.gamepad.axes.length !== 4
      || !v.gamepad.axes.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1)
      || !Array.isArray(v.gamepad.buttons) || v.gamepad.buttons.length !== 17
      || !v.gamepad.buttons.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1))) return null;
    return v;
  } catch { return null; }
}
