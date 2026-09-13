export const MESSAGE_SOUND_SOURCE = "./audio/text/text_notification.ogg";
let sound: HTMLAudioElement | undefined;
let playback = 0;

function getSound(): HTMLAudioElement | undefined {
  if (typeof Audio === "undefined") return;
  if (!sound) { sound = new Audio(MESSAGE_SOUND_SOURCE); sound.preload = "auto"; }
  return sound;
}

export function prepareMessageSound(): () => void {
  getSound()?.load();
  // Libera a reprodução no primeiro gesto, antes de a mensagem remota chegar.
  const unlock = () => {
    const audio = getSound();
    if (!audio) return;
    audio.muted = true;
    const attempt = playback;
    void audio.play().then(() => {
      if (playback === attempt) { audio.pause(); audio.currentTime = 0; }
    }).catch(() => undefined).finally(() => { audio.muted = false; });
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
  };
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
  return () => {
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
    sound?.pause();
    sound = undefined;
  };
}

export function playMessageSound(): void {
  playback++;
  const audio = getSound();
  if (!audio) return;
  audio.muted = false;
  audio.currentTime = 0;
  void audio.play().catch((error) => console.warn("Não foi possível reproduzir o aviso de mensagem.", error));
}
