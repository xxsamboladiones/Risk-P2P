import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeGameControl, type GameInputFrame } from "@risk/protocol";
import type { CallTransport } from "@risk/rtc";
import { GameModeController } from "./GameModeController";
import type { GameBackend } from "./DesktopGameBackend";

function setup() {
  const sendData = vi.fn((_data: string, _peer?: string) => 1);
  const backend: GameBackend = { request: vi.fn(async (op: string) => (op === "join" ? { slot: 0 } : { gamepad: true, keyboardMouse: true, players: [] })) as GameBackend["request"], input: vi.fn(async () => {}) };
  let screen: string | undefined = "screen";
  let authenticated = true;
  const game = new GameModeController({ transport: () => ({ sendData, sendGameInput: () => true, ensureGameInputChannel: vi.fn() } as unknown as CallTransport), authenticated: () => authenticated,
    canHost: () => true, screenId: () => screen, quality: vi.fn(async () => {}) }, backend);
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { game, backend, sendData, settle, screen: (value?: string) => { screen = value; }, auth: (value: boolean) => { authenticated = value; } };
}
afterEach(() => vi.useRealTimers());
describe("Modo Jogo", () => {
  it("substitui concessão atomicamente e ignora pacotes da concessão anterior", async () => {
    vi.useFakeTimers(); const t = setup(); await t.game.start();
    const sessionId = t.game.getSnapshot().host!.sessionId;
    t.game.handleControl("peer", encodeGameControl({ type: "join-request", sessionId, requestId: "r", device: "keyboard-mouse" })); await t.settle();
    const old = t.game.getSnapshot().host!.players[0]!;
    t.game.handleControl("peer", encodeGameControl({ type: "join-request", sessionId, requestId: "switch", previousGrantId: old.grantId, device: "gamepad" })); await t.settle();
    const next = t.game.getSnapshot().host!.players[0]!;
    expect(t.game.getSnapshot().host!.players).toHaveLength(1); expect(next.grantId).not.toBe(old.grantId);
    expect(t.backend.request).toHaveBeenLastCalledWith("join", expect.objectContaining({ previousGrantId: old.grantId }));
    t.game.handleInput("peer", JSON.stringify({ version: 1, sessionId, grantId: old.grantId, sequence: 4, keys: [], buttons: 0, x: 0, y: 0, wheel: 0 }));
    expect(t.backend.input).not.toHaveBeenCalled(); await t.game.reset();
  });
  it("não ressuscita jogador revogado durante a troca", async () => {
    vi.useFakeTimers(); const t = setup(); await t.game.start();
    const sessionId = t.game.getSnapshot().host!.sessionId;
    t.game.handleControl("peer", encodeGameControl({ type: "join-request", sessionId, requestId: "r", device: "keyboard-mouse" })); await t.settle();
    const old = t.game.getSnapshot().host!.players[0]!;
    let finish!: (value: {slot: number}) => void;
    vi.mocked(t.backend.request).mockImplementationOnce(() => new Promise((done) => { finish = done as typeof finish; }));
    t.game.handleControl("peer", encodeGameControl({ type: "join-request", sessionId, requestId: "switch", previousGrantId: old.grantId, device: "gamepad" }));
    await t.game.revoke("peer", false); finish({ slot: 1 }); await t.settle();
    expect(t.game.getSnapshot().host!.players).toHaveLength(0);
    expect(t.sendData.mock.calls.map(([raw]) => JSON.parse(raw)).filter((m) => m.type === "join-accepted" && m.requestId === "switch")).toHaveLength(0);
    await t.game.reset();
  });
  it("preserva concessão anterior ao rejeitar uma troca de dispositivo", () => {
    vi.useFakeTimers(); const t = setup();
    t.game.handleControl("host", encodeGameControl({ type: "game-mode-start", sessionId: "s", screenStreamId: "screen", gamepad: true }));
    t.game.join("host", "keyboard-mouse");
    const first = JSON.parse(t.sendData.mock.calls.at(-1)![0]);
    t.game.handleControl("host", encodeGameControl({ type: "join-accepted", sessionId: "s", requestId: first.requestId, grantId: "old", device: "keyboard-mouse", slot: 0 }));
    t.game.switchDevice("gamepad");
    const request = JSON.parse(t.sendData.mock.calls.at(-1)![0]);
    expect(request.previousGrantId).toBe("old");
    t.game.handleControl("host", encodeGameControl({ type: "join-rejected", sessionId: "s", requestId: request.requestId, reason: "ocupado" }));
    expect(t.game.getSnapshot().playing?.grantId).toBe("old");
    expect(t.game.getSnapshot().pending).toBeUndefined(); t.game.leave();
  });
  it("mantém o jogador quando uma requisição local de input falha temporariamente", async () => {
    vi.useFakeTimers(); const t = setup(); await t.game.start();
    const sessionId = t.game.getSnapshot().host!.sessionId;
    t.game.handleControl("peer", encodeGameControl({ type: "join-request", sessionId, requestId: "r", device: "keyboard-mouse" })); await t.settle();
    const grantId = t.game.getSnapshot().host!.players[0]!.grantId;
    vi.mocked(t.backend.input).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const frame = { version: 1, sessionId, grantId, sequence: 0, keys: [], buttons: 0, x: 0, y: 0, wheel: 0 };
    t.game.handleInput("peer", JSON.stringify(frame)); await t.settle();
    expect(t.game.getSnapshot().host!.players).toHaveLength(1);
    t.game.handleInput("peer", JSON.stringify({ ...frame, sequence: 1 })); await t.settle();
    expect(t.backend.input).toHaveBeenCalledTimes(2);
    await t.game.reset();
  });
  it("tolera uma falha transitória no heartbeat e encerra após indisponibilidade prolongada", async () => {
    vi.useFakeTimers(); const t = setup(); await t.game.start();
    vi.mocked(t.backend.request).mockRejectedValue(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(800);
    expect(t.game.getSnapshot().host).toBeDefined();
    await vi.advanceTimersByTimeAsync(4500);
    expect(t.game.getSnapshot().host).toBeUndefined();
  });
  it("aceita automaticamente peers autenticados, bloqueia pacotes antigos e revoga sem permitir nova entrada", async () => {
    vi.useFakeTimers(); const t = setup(); await t.game.start();
    const sessionId = t.game.getSnapshot().host!.sessionId;
    const join = encodeGameControl({ type: "join-request", sessionId, requestId: "request", device: "keyboard-mouse" });
    t.auth(false); t.game.handleControl("peer", join); await t.settle();
    expect(t.game.getSnapshot().host!.players).toHaveLength(0);
    t.auth(true); t.game.handleControl("peer", join); await t.settle();
    const player = t.game.getSnapshot().host!.players[0]!;
    const frame: GameInputFrame = { version: 1, sessionId, grantId: player.grantId, sequence: 2, keys: ["KeyW"], buttons: 0, x: 10, y: 5, wheel: 0 };
    t.game.handleInput("stranger", JSON.stringify(frame));
    t.game.handleInput("peer", JSON.stringify({ ...frame, sessionId: "old" }));
    expect(t.backend.input).not.toHaveBeenCalled();
    t.game.handleInput("peer", JSON.stringify(frame)); await t.settle();
    t.game.handleInput("peer", JSON.stringify({ ...frame, sequence: 1, keys: [] }));
    expect(t.backend.input).toHaveBeenCalledOnce();
    await t.game.revoke("peer");
    t.game.handleInput("peer", JSON.stringify({ ...frame, sequence: 3 }));
    t.game.handleControl("peer", join); await t.settle();
    expect(t.game.getSnapshot().host!.players).toHaveLength(0);
    expect(t.backend.input).toHaveBeenCalledOnce();
    await t.game.reset();
  });
  it("encerra o modo e descarta concessões atrasadas quando o compartilhamento acaba", async () => {
    vi.useFakeTimers(); const t = setup(); await t.game.start();
    const sessionId = t.game.getSnapshot().host!.sessionId;
    let resolve!: (value: { slot: number }) => void;
    vi.mocked(t.backend.request).mockImplementationOnce(() => new Promise((done) => { resolve = done as typeof resolve; }));
    t.game.handleControl("peer", encodeGameControl({ type: "join-request", sessionId, requestId: "r", device: "keyboard-mouse" }));
    t.screen(); t.game.screenChanged(); resolve({ slot: 0 }); await t.settle();
    expect(t.game.getSnapshot().host).toBeUndefined();
    expect(t.sendData.mock.calls.map(([raw]) => JSON.parse(raw as string).type)).not.toContain("join-accepted");
    expect(t.backend.request).toHaveBeenCalledWith("revoke", expect.objectContaining({ peerId: "peer" }));
  });
  it("coalesce input congestionado mantendo apenas o snapshot mais recente", async () => {
    vi.useFakeTimers(); const t = setup(); await t.game.start();
    const sessionId = t.game.getSnapshot().host!.sessionId;
    t.game.handleControl("peer", encodeGameControl({ type: "join-request", sessionId, requestId: "r", device: "keyboard-mouse" })); await t.settle();
    const grantId = t.game.getSnapshot().host!.players[0]!.grantId;
    let done!: () => void;
    vi.mocked(t.backend.input).mockImplementationOnce(() => new Promise((resolve) => { done = resolve; }));
    for (let sequence = 0; sequence < 20; sequence++) t.game.handleInput("peer", JSON.stringify({ version: 1, sessionId, grantId, sequence, keys: [], buttons: 0, x: sequence, y: 0, wheel: 0 }));
    expect(t.backend.input).toHaveBeenCalledOnce(); done(); await t.settle();
    expect(t.backend.input).toHaveBeenCalledTimes(2);
    expect(t.backend.input).toHaveBeenLastCalledWith("peer", expect.objectContaining({ sequence: 19, x: 19 }));
    await t.game.reset();
  });
  it("não aceita autorização de outra sessão e envia leave para aceite que chegou depois do cancelamento", () => {
    vi.useFakeTimers(); const t = setup();
    t.game.handleControl("host", encodeGameControl({ type: "game-mode-start", sessionId: "s", screenStreamId: "screen", gamepad: true }));
    t.game.join("host", "keyboard-mouse");
    const request = JSON.parse(t.sendData.mock.calls.at(-1)![0] as string);
    t.game.leave();
    t.game.handleControl("host", encodeGameControl({ type: "join-accepted", sessionId: "s", requestId: request.requestId, grantId: "g", device: "keyboard-mouse", slot: 0 }));
    expect(t.game.getSnapshot().playing).toBeUndefined();
    expect(JSON.parse(t.sendData.mock.calls.at(-1)![0] as string).type).toBe("leave");
  });
});
