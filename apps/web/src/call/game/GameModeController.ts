import { encodeGameControl, parseGameControl, parseGameInput, type GameControl, type GameDevice, type GameInputFrame } from "@risk/protocol";
import type { CallTransport, PeerConnectionDiagnostics } from "@risk/rtc";
import { DesktopGameBackend, isPermanentGameError, type GameBackend, type GameCapabilities, type GamePlayer } from "./DesktopGameBackend";
import { gameQuality } from "./quality-policy";

type Offer = { sessionId: string; screenStreamId: string; gamepad: boolean; reason?: string };
type Host = Offer & { players: GamePlayer[] };
type Playing = GamePlayer & { sessionId: string };
export type GameView = { host?: Host; offers: Record<string, Offer>; playing?: Playing; pending?: string; error?: string; quality?: "720p60" | "1080p60" };
type Dependencies = {
  transport(): CallTransport | undefined; authenticated(peerId: string): boolean;
  canHost(): boolean; screenId(): string | undefined;
  quality(value: "720p60" | "1080p60" | undefined): Promise<void>;
};
export class GameModeController {
  private view: GameView = { offers: {} };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeatBusy = false;
  private lastHeartbeat = 0;
  private blocked = new Set<string>();
  private joining = new Set<string>();
  private queues = new Map<string, { busy: boolean; latest?: GameInputFrame; sequence: number }>();
  private request?: { switching?: boolean; id: string; peer: string; session: string; timer: ReturnType<typeof setTimeout> };
  private lastQualityChange = 0;
  private starting = false;
  constructor(private readonly deps: Dependencies, private readonly backend: GameBackend = new DesktopGameBackend()) {}
  getSnapshot = (): GameView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<GameView>): void { this.view = { ...this.view, ...patch }; this.listeners.forEach((listener) => listener()); }
  private send(peer: string | undefined, message: GameControl): void { this.deps.transport()?.sendData(encodeGameControl(message), peer); }
  private announce(peer?: string): void { const h = this.view.host; if (h) this.send(peer, { type: "game-mode-start", sessionId: h.sessionId, screenStreamId: h.screenStreamId, gamepad: h.gamepad, reason: h.reason }); }
  async start(): Promise<void> {
    if (this.view.host || this.starting) return;
    this.starting = true;
    try {
    const screenStreamId = this.deps.screenId();
    if (!screenStreamId || !this.deps.canHost() || !this.deps.transport()?.sendGameInput) throw new Error("Compartilhe uma tela em uma chamada P2P autenticada para ativar o Modo Jogo.");
    const epoch = ++this.epoch;
    const sessionId = crypto.randomUUID();
    const capabilities = await this.backend.request<GameCapabilities>("start", { sessionId });
    if (epoch !== this.epoch || this.deps.screenId() !== screenStreamId) { await this.backend.request("stop", { sessionId }); return; }
    this.blocked.clear();
    this.lastHeartbeat = performance.now();
    this.update({ host: { sessionId, screenStreamId, gamepad: capabilities.gamepad, reason: capabilities.reason?.slice(0, 160), players: [] }, error: undefined, quality: "720p60" });
    this.timer = setInterval(() => void this.heartbeat(), 400);
    try { await this.deps.quality("720p60"); } catch (error) { await this.stop(); throw error; }
    if (this.getSnapshot().host?.sessionId === sessionId) this.announce();
    } finally { this.starting = false; }
  }
  async stop(): Promise<void> {
    ++this.epoch;
    const host = this.view.host;
    clearInterval(this.timer); this.timer = undefined;
    this.joining.clear(); this.queues.clear();
    this.update({ host: undefined, quality: undefined });
    if (host) {
      this.send(undefined, { type: "game-mode-stop", sessionId: host.sessionId });
      await Promise.allSettled([this.backend.request("stop", { sessionId: host.sessionId }), this.deps.quality(undefined)]);
    }
  }
  screenChanged(): void { if (this.view.host && this.view.host.screenStreamId !== this.deps.screenId()) void this.stop(); }
  peerReady(peer: string): void {
    this.deps.transport()?.ensureGameInputChannel?.(peer);
    this.send(peer, { type: "game-sync", sessionId: "sync" });
    this.announce(peer);
  }
  peerLeft(peer: string): void {
    const offers = { ...this.view.offers }; delete offers[peer]; this.update({ offers });
    if (this.view.playing?.peerId === peer || this.request?.peer === peer) this.leave();
    void this.revoke(peer, false);
  }
  handleControl(peer: string, raw: string): boolean {
    const message = parseGameControl(raw);
    if (!message) return false;
    if (!this.deps.authenticated(peer)) return true;
    const host = this.view.host;
    switch (message.type) {
      case "game-sync": this.announce(peer); break;
      case "game-mode-start":
        if (this.view.playing?.peerId === peer && this.view.playing.sessionId !== message.sessionId) this.leave();
        this.update({ offers: { ...this.view.offers, [peer]: message } }); break;
      case "game-mode-stop":
        if (this.view.offers[peer]?.sessionId === message.sessionId) {
          const offers = { ...this.view.offers }; delete offers[peer]; this.update({ offers });
          if (this.view.playing?.peerId === peer || this.request?.peer === peer) this.leave();
        } break;
      case "join-request":
        if (host?.sessionId === message.sessionId) void this.accept(peer, message); break;
      case "join-accepted":
        if (this.request?.peer === peer && this.request.id === message.requestId && this.request.session === message.sessionId) {
          clearTimeout(this.request.timer); this.request = undefined;
          this.update({ playing: { ...message, peerId: peer }, pending: undefined });
          this.deps.transport()?.setGameModePlayback?.(peer, true);
        } else if (this.view.playing?.peerId !== peer || this.view.playing.grantId !== message.grantId || this.view.playing.sessionId !== message.sessionId) this.send(peer, { type: "leave", sessionId: message.sessionId, grantId: message.grantId });
        break;
      case "join-rejected":
        if (this.request?.peer === peer && this.request.id === message.requestId && this.request.session === message.sessionId) { if (this.request.switching) { clearTimeout(this.request.timer); this.request = undefined; this.update({ pending: undefined }); } else this.leave(); this.update({ error: message.reason }); } break;
      case "leave":
        if (host?.sessionId === message.sessionId && host.players.some((p) => p.peerId === peer && p.grantId === message.grantId)) void this.revoke(peer, false); break;
      case "revoked":
        if (this.view.playing?.peerId === peer && this.view.playing.sessionId === message.sessionId && this.view.playing.grantId === message.grantId) { this.leave(); this.update({ error: "O acesso ao jogo foi encerrado pelo anfitrião." }); } break;
    }
    return true;
  }
  private async accept(peer: string, request: Extract<GameControl, { type: "join-request" }>): Promise<void> {
    const host = this.view.host;
    if (!host || this.joining.has(peer)) return;
    const reject = (reason: string) => this.send(peer, { type: "join-rejected", sessionId: request.sessionId, requestId: request.requestId, reason: reason.slice(0, 160) });
    if (this.blocked.has(peer)) { reject("O anfitrião revogou seu acesso nesta sessão."); return; }
    const previous = host.players.find((p) => p.peerId === peer);
    if (request.previousGrantId ? previous?.grantId !== request.previousGrantId : Boolean(previous)) { reject("Concessão de jogo inválida."); return; }
    const grantId = crypto.randomUUID();
    this.joining.add(peer);
    this.queues.delete(peer);
    try {
      const { slot } = await this.backend.request<{ slot: number }>("join", { sessionId: host.sessionId, peerId: peer, grantId, device: request.device, previousGrantId: request.previousGrantId });
      if (this.view.host?.sessionId !== host.sessionId || this.deps.screenId() !== host.screenStreamId || !this.deps.authenticated(peer) || this.blocked.has(peer) || (previous && !this.view.host.players.includes(previous))) {
        await this.backend.request("revoke", { sessionId: host.sessionId, peerId: peer, grantId }); return;
      }
      const player = { peerId: peer, grantId, slot, device: request.device, requestId: request.requestId };
      this.queues.delete(peer);
      this.update({ host: { ...this.view.host, players: [...this.view.host.players.filter((p) => p !== previous), player] } });
      this.send(peer, { type: "join-accepted", sessionId: host.sessionId, ...player });
    } catch (error) { reject(error instanceof Error ? error.message : "Não foi possível liberar o acesso."); }
    finally { this.joining.delete(peer); }
  }
  async revoke(peer: string, block = true): Promise<void> {
    if (block) this.blocked.add(peer);
    const host = this.view.host;
    const player = host?.players.find((p) => p.peerId === peer);
    if (!host || !player) return;
    this.queues.delete(peer);
    this.update({ host: { ...host, players: host.players.filter((p) => p !== player) } });
    this.send(peer, { type: "revoked", sessionId: host.sessionId, grantId: player.grantId });
    await this.backend.request("revoke", { sessionId: host.sessionId, peerId: peer, grantId: player.grantId }).catch(() => undefined);
  }
  join(peer: string, device: GameDevice): void {
    this.leave();
    const offer = this.view.offers[peer];
    if (!offer || !this.deps.authenticated(peer)) return;
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { this.leave(); this.update({ error: "Não foi possível entrar no jogo. Tente novamente." }); }, 5000);
    this.request = { id, peer, session: offer.sessionId, timer };
    this.update({ pending: peer, error: undefined });
    this.send(peer, { type: "join-request", sessionId: offer.sessionId, requestId: id, device });
  }
  setScreenPlayback(peer: string, enabled: boolean): void { this.deps.transport()?.setScreenPlayback?.(peer, enabled); }
  switchDevice(device: GameDevice): void {
    const playing = this.view.playing;
    if (!playing || this.request || playing.device === device) return;
    const offer = this.view.offers[playing.peerId];
    if (!offer || (device === "gamepad" && !offer.gamepad)) { this.update({ error: offer?.reason ?? "Controle indisponível neste anfitrião." }); return; }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { this.leave(); this.update({ error: "A troca não foi confirmada. Entre novamente para continuar." }); }, 10000);
    this.request = { id, peer: playing.peerId, session: playing.sessionId, timer, switching: true };
    this.update({ pending: playing.peerId, error: undefined });
    this.send(playing.peerId, { type: "join-request", sessionId: playing.sessionId, requestId: id, device, previousGrantId: playing.grantId });
  }
  leave(): void {
    if (this.request) clearTimeout(this.request.timer);
    this.request = undefined;
    const playing = this.view.playing;
    if (playing) this.deps.transport()?.setGameModePlayback?.(playing.peerId, false);
    this.update({ playing: undefined, pending: undefined });
    if (playing) this.send(playing.peerId, { type: "leave", sessionId: playing.sessionId, grantId: playing.grantId });
  }
  sendInput(frame: GameInputFrame): boolean {
    const p = this.view.playing;
    return Boolean(p && p.sessionId === frame.sessionId && p.grantId === frame.grantId && this.deps.transport()?.sendGameInput?.(p.peerId, JSON.stringify(frame)));
  }
  handleInput(peer: string, raw: string): void {
    const host = this.view.host;
    if (!host || this.joining.has(peer) || !this.deps.authenticated(peer) || this.deps.screenId() !== host.screenStreamId) return;
    const frame = parseGameInput(raw);
    const player = host.players.find((p) => p.peerId === peer);
    if (!frame || !player || frame.sessionId !== host.sessionId || frame.grantId !== player.grantId) return;
    const queue = this.queues.get(peer) ?? { busy: false, sequence: -1 };
    if (frame.sequence <= queue.sequence) return;
    queue.sequence = frame.sequence; queue.latest = frame; this.queues.set(peer, queue);
    if (queue.busy) return;
    queue.busy = true;
    void (async () => {
      try {
        while (queue.latest && this.queues.get(peer) === queue) {
          const next = queue.latest; queue.latest = undefined;
          await this.backend.input(peer, next);
        }
      } catch (error) {
        // Um erro transitório perde apenas este snapshot. O watchdog nativo solta
        // entradas paradas, e o próximo snapshot pode retomar a mesma concessão.
        if (isPermanentGameError(error) && this.queues.get(peer) === queue) await this.revoke(peer, false);
      }
      finally { queue.busy = false; }
    })();
  }
  private async heartbeat(): Promise<void> {
    const host = this.view.host;
    if (!host || this.heartbeatBusy) return;
    if (this.deps.screenId() !== host.screenStreamId) { await this.stop(); return; }
    this.heartbeatBusy = true;
    try {
      const status = await this.backend.request<{ players: string[] }>("heartbeat", { sessionId: host.sessionId });
      if (this.view.host?.sessionId === host.sessionId) this.lastHeartbeat = performance.now();
      if (this.view.host?.sessionId === host.sessionId) for (const p of host.players) if (!this.joining.has(p.peerId) && !status.players.includes(p.grantId) && this.view.host.players.includes(p)) await this.revoke(p.peerId, false);
    } catch (error) {
      if (this.view.host?.sessionId === host.sessionId && (isPermanentGameError(error) || performance.now() - this.lastHeartbeat >= 4500)) {
        await this.stop(); this.update({ error: error instanceof Error ? error.message : "Modo Jogo interrompido." });
      }
    } finally { this.heartbeatBusy = false; }
  }
  adapt(diagnostics: PeerConnectionDiagnostics[]): void {
    if (!this.view.host || Date.now() - this.lastQualityChange < 10_000) return;
    const quality = gameQuality(this.view.quality ?? "720p60", diagnostics);
    if (quality === this.view.quality) return;
    this.lastQualityChange = Date.now();
    this.update({ quality }); void this.deps.quality(quality).catch(() => undefined);
  }
  async reset(): Promise<void> { this.leave(); await this.stop(); this.update({ offers: {}, error: undefined }); }
}
