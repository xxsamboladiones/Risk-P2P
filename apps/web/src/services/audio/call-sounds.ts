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
