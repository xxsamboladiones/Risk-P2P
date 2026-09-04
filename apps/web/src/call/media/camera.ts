export type CameraSession = {
  stream: MediaStream;
  track: MediaStreamTrack;
};

export async function openCamera(): Promise<CameraSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error("Nenhuma câmera foi disponibilizada pelo navegador.");
  }
  return { stream, track };
}
