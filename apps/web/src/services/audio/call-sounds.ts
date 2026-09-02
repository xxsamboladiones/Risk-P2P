export type CallSound = "connect" | "disconnect";

export const CALL_SOUND_SOURCES: Record<CallSound, string> = {
  connect: "./audio/call/connect.ogg",
  disconnect: "./audio/call/disconnect.ogg",
};

const sounds = new Map<CallSound, HTMLAudioElement>();
let activeSound: HTMLAudioElement | undefined;

export function callSoundForRoomTransition(previousRoomId: string | null, roomId: string | null): CallSound | null {
  if (previousRoomId === roomId) return null;
  if (roomId) return "connect";
  return previousRoomId ? "disconnect" : null;
}

/**
 * Mantém os sons de presença remota separados da transição local de sala.
 * Peers encontrados durante a sincronização inicial ficam silenciosos: quem
 * acabou de entrar já ouve o próprio som de conexão e não deve ouvir um som
 * adicional para cada pessoa que já estava na chamada.
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

  enable(): void { this.ready = true; }

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
  if (typeof Audio === "undefined") return;
  const sound = getCallSound(kind);
  if (activeSound) {
    activeSound.pause();
    activeSound.currentTime = 0;
  }
  sound.currentTime = 0;
  activeSound = sound;
  void sound.play().catch((error) => {
    console.warn(`Não foi possível reproduzir o som de ${kind === "connect" ? "conexão" : "desconexão"} da chamada.`, error);
  });
}

function getCallSound(kind: CallSound): HTMLAudioElement {
  const cached = sounds.get(kind);
  if (cached) return cached;
  const sound = new Audio(CALL_SOUND_SOURCES[kind]);
  sound.preload = "auto";
  sound.volume = 0.6;
  sounds.set(kind, sound);
  return sound;
}
