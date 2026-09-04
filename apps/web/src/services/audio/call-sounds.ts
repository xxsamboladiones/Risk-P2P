export type CallSound = "connect" | "disconnect";

export const CALL_SOUND_SOURCES: Record<CallSound, string> = {
  connect: "./audio/call/connect.ogg",
  disconnect: "./audio/call/disconnect.ogg",
};

const sounds = new Map<CallSound, HTMLAudioElement>();
let activeSound: HTMLAudioElement | undefined;
let playbackSequence = 0;
let callAudioContext: AudioContext | undefined;
let activeConnectOscillators: OscillatorNode[] = [];

/**
 * Mantém os sons de presença alinhados ao ciclo de vida real da chamada.
 * Peers encontrados durante a sincronização inicial ficam silenciosos: quem
 * acabou de entrar ouve um único som local e não um som adicional para cada
 * pessoa que já estava na sala. Depois disso, cada peer novo autenticado gera
 * um som para quem já estava conectado.
 */
export class CallPresenceSoundState {
  private ready = false;
  private readonly initialPeers = new Set<string>();
  private readonly acceptedPeers = new Set<string>();

  reset(): void {
    this.ready = false;
    this.initialPeers.clear();
    this.acceptedPeers.clear();
  }

  enable(): void {
    this.ready = true;
  }

  disable(): CallSound | null {
    const sound = this.ready ? "disconnect" : null;
    this.reset();
    return sound;
  }

  observe(peerId: string): void {
    if (!this.ready) this.initialPeers.add(peerId);
  }

  accept(peerId: string): CallSound | null {
    if (this.acceptedPeers.has(peerId)) return null;
    this.acceptedPeers.add(peerId);
    if (this.initialPeers.delete(peerId) || !this.ready) return null;
    return "connect";
  }

  leave(peerId: string): CallSound | null {
    this.initialPeers.delete(peerId);
    if (!this.acceptedPeers.delete(peerId) || !this.ready) return null;
    return "disconnect";
  }
}

export function preloadCallSounds(): void {
  if (typeof Audio === "undefined") return;
  getCallSound("connect").load();
  getCallSound("disconnect").load();
}

export function playCallSound(kind: CallSound): void {
  const sequence = ++playbackSequence;
  stopConnectTone();
  if (kind === "connect" && playConnectTone()) {
    stopActiveMediaSound();
    return;
  }
  if (typeof Audio === "undefined") return;
  void playWithRecovery(kind, sequence);
}

async function playWithRecovery(kind: CallSound, sequence: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sound = getCallSound(kind);
    stopActiveMediaSound();
    rewind(sound);
    sound.muted = false;
    activeSound = sound;
    try {
      await sound.play();
      return;
    } catch (error) {
      lastError = error;
      if (sequence !== playbackSequence) return;
      evictCallSound(kind, sound);
    }
  }
  warnPlaybackFailure(kind, lastError);
}

function playConnectTone(): boolean {
  if (typeof AudioContext === "undefined") return false;
  try {
    if (!callAudioContext || callAudioContext.state === "closed") {
      callAudioContext = new AudioContext({ latencyHint: "interactive" });
    }
    const context = callAudioContext;
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    const start = context.currentTime + 0.01;
    activeConnectOscillators = [
      scheduleConnectNote(context, 523.25, start, 0.22),
      scheduleConnectNote(context, 783.99, start + 0.14, 0.28),
    ];
    return true;
  } catch (error) {
    console.warn("Não foi possível gerar o som de conexão; usando o arquivo de áudio como fallback.", error);
    return false;
  }
}

function scheduleConnectNote(context: AudioContext, frequency: number, start: number, duration: number): OscillatorNode {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.14, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.01);
  return oscillator;
}

function stopConnectTone(): void {
  activeConnectOscillators.forEach((oscillator) => {
    try { oscillator.stop(); } catch { /* o tom já terminou */ }
    oscillator.disconnect();
  });
  activeConnectOscillators = [];
}

function stopActiveMediaSound(): void {
  if (!activeSound) return;
  activeSound.pause();
  rewind(activeSound);
  activeSound = undefined;
}

function rewind(sound: HTMLAudioElement): void {
  // Chromium pode lançar InvalidStateError quando o recurso do protocolo
  // empacotado ainda não terminou de carregar. Isso não deve impedir play().
  try { sound.currentTime = 0; } catch { /* o play inicia no começo na primeira execução */ }
}

function warnPlaybackFailure(kind: CallSound, error: unknown): void {
  console.warn(`Não foi possível reproduzir o som de ${kind === "connect" ? "conexão" : "desconexão"} da chamada.`, error);
}

function getCallSound(kind: CallSound): HTMLAudioElement {
  const cached = sounds.get(kind);
  if (cached) return cached;
  const sound = new Audio(resolveCallSoundSource(CALL_SOUND_SOURCES[kind]));
  sound.preload = "auto";
  sound.volume = 0.6;
  sound.addEventListener?.("error", () => evictCallSound(kind, sound), { once: true });
  sounds.set(kind, sound);
  return sound;
}

function resolveCallSoundSource(source: string): string {
  if (typeof document === "undefined") return source;
  return new URL(source, document.baseURI).href;
}

function evictCallSound(kind: CallSound, sound: HTMLAudioElement): void {
  if (sounds.get(kind) === sound) sounds.delete(kind);
  if (activeSound === sound) activeSound = undefined;
}
