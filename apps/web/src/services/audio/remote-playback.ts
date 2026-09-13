export type RemoteAudioPlayback = {
  setVolume(volume: number): void;
  stop(): void;
};

export function createRemoteAudioPlayback(stream: MediaStream, volume: number): RemoteAudioPlayback {
  // No Chromium, a entrada WebRTC do Web Audio depende de um media element
  // reproduzindo o stream remoto. O vídeo da tile muda para a tela compartilhada;
  // por isso cada áudio precisa manter seu próprio elemento durante a chamada.
  const element = new Audio();
  element.autoplay = true;
  element.muted = true; // A saída audível passa somente pelo GainNode (0–200%).
  element.srcObject = stream;

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  gain.gain.value = volume / 100;
  source.connect(gain).connect(context.destination);
  let stopped = false;
  const resume = () => {
    if (stopped) return;
    void element.play().catch((error) => {
      if (!stopped) console.warn("Não foi possível iniciar a reprodução do áudio remoto.", error);
    });
    if (context.state === "suspended") void context.resume().catch(() => undefined);
  };
  const onVisible = () => { if (document.visibilityState === "visible") resume(); };
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", onVisible);
  resume();

  return {
    setVolume(nextVolume) {
      if (stopped) return;
      gain.gain.setTargetAtTime(nextVolume / 100, context.currentTime, 0.015);
      resume();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", onVisible);
      element.pause();
      element.srcObject = null;
      source.disconnect();
      gain.disconnect();
      void context.close().catch(() => undefined);
    },
  };
}
