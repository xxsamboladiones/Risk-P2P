// Execute com o Electron: electron scripts/verify-remote-screen-audio.cjs
// Duas conexões locais, sinal sintético e janela oculta; não usa microfone,
// conta, servidor de signaling ou chamada do usuário.
const { app, BrowserWindow } = require("electron");
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("../apps/web/node_modules/typescript");
const reportDirectory = path.resolve(__dirname, "../.risk/remote-screen-audio");
mkdirSync(reportDirectory, { recursive: true });
app.setPath("userData", path.join(reportDirectory, "profile"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

async function verify() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const input = new AudioContext();
  const oscillator = input.createOscillator();
  const microphone = input.createMediaStreamDestination();
  oscillator.connect(microphone);
  oscillator.start();
  await input.resume();
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const streams = [];
  const errors = [];
  sender.onicecandidate = ({ candidate }) => { if (candidate) void receiver.addIceCandidate(candidate).catch((error) => errors.push(String(error))); };
  receiver.onicecandidate = ({ candidate }) => { if (candidate) void sender.addIceCandidate(candidate).catch((error) => errors.push(String(error))); };
  receiver.ontrack = ({ streams: received }) => { if (!streams.includes(received[0])) streams.push(received[0]); };
  async function negotiate() {
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
  }
  sender.addTrack(microphone.stream.getAudioTracks()[0], microphone.stream);
  await negotiate();
  await wait(1000);
  const remoteMicrophone = streams[0];
  const video = document.createElement("video");
  video.muted = true;
  document.body.append(video);
  video.srcObject = remoteMicrophone;
  await video.play();

  const originalPlayback = new AudioContext();
  const originalSource = originalPlayback.createMediaStreamSource(remoteMicrophone);
  const originalAnalyser = originalPlayback.createAnalyser();
  originalSource.connect(originalAnalyser).connect(originalPlayback.destination);
  await originalPlayback.resume();
  const measurements = [];
  async function sample(label, analyser) {
    await wait(1200);
    const data = new Float32Array(analyser.fftSize);
    let energy = 0;
    for (let i = 0; i < 10; i++) {
      analyser.getFloatTimeDomainData(data);
      energy += data.reduce((sum, value) => sum + value * value, 0) / data.length;
      await wait(40);
    }
    const stats = [...(await receiver.getStats()).values()].find((item) => item.type === "inbound-rtp" && item.kind === "audio");
    const result = { label, rms: Math.sqrt(energy / 10), packetsReceived: stats?.packetsReceived, trackMuted: remoteMicrophone.getAudioTracks()[0].muted };
    measurements.push(result);
    return result;
  }
  const before = await sample("original-before-screen", originalAnalyser);
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 180;
  const drawing = canvas.getContext("2d");
  drawing.fillRect(0, 0, 320, 180);
  const screen = canvas.captureStream(5);
  const drawTimer = setInterval(() => drawing.fillRect(0, 0, 320, 180), 200);
  const screenTrack = screen.getVideoTracks()[0];
  let screenSender = sender.addTrack(screenTrack, screen);
  await negotiate();
  video.srcObject = streams.find((stream) => stream.getVideoTracks().length);
  await video.play();
  const broken = await sample("original-screen-without-audio", originalAnalyser);
  await originalPlayback.close();

  // Observa a saída do GainNode real sem substituir WebRTC nem Web Audio.
  const NativeAudioContext = AudioContext;
  let fixedContext;
  let fixedGain;
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) { super(...args); fixedContext = this; }
    createGain() { fixedGain = super.createGain(); return fixedGain; }
  };
  const playback = window.createRemoteAudioPlayback(remoteMicrophone, 100);
  window.AudioContext = NativeAudioContext;
  const fixedAnalyser = fixedContext.createAnalyser();
  fixedGain.connect(fixedAnalyser);
  const fixed = await sample("fixed-screen-without-audio", fixedAnalyser);
  sender.removeTrack(screenSender);
  await negotiate();
  video.srcObject = remoteMicrophone;
  await video.play();
  const stopped = await sample("fixed-screen-stopped", fixedAnalyser);
  screenSender = sender.addTrack(screenTrack, screen);
  await negotiate();
  video.srcObject = streams.find((stream) => stream.getVideoTracks().length);
  await video.play();
  const restarted = await sample("fixed-screen-restarted-without-audio", fixedAnalyser);
  playback.setVolume(0);
  const muted = await sample("fixed-volume-zero", fixedAnalyser);
  playback.setVolume(200);
  const amplified = await sample("fixed-volume-200", fixedAnalyser);
  playback.stop();
  clearInterval(drawTimer);
  screenTrack.stop();
  microphone.stream.getTracks().forEach((track) => track.stop());
  sender.close(); receiver.close(); await input.close();
  const passed = before.rms > 0.1 && fixed.rms > 0.1 && stopped.rms > 0.1 && restarted.rms > 0.1
    && muted.rms < 0.001 && amplified.rms > restarted.rms * 1.7 && !errors.length;
  return {
    passed,
    reproducedOriginalFailure: broken.rms < 0.001 && broken.packetsReceived > before.packetsReceived && !broken.trackMuted,
    measurements, errors,
  };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.setAudioMuted(true);
  const timeout = setTimeout(() => app.exit(2), 35000);
  try {
    await window.loadURL("data:text/html,<html><body></body></html>");
    const source = readFileSync(path.resolve(__dirname, "../apps/web/src/services/audio/remote-playback.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    await window.webContents.executeJavaScript(`{ const exports = {}; ${compiled}; window.createRemoteAudioPlayback = exports.createRemoteAudioPlayback; } void 0;`);
    const report = await window.webContents.executeJavaScript(`(${verify.toString()})()`);
    writeFileSync(path.join(reportDirectory, "report.json"), JSON.stringify({ electron: process.versions.electron, ...report }, null, 2));
    console.log(JSON.stringify(report));
    clearTimeout(timeout);
    app.exit(report.passed ? 0 : 1);
  } catch (error) {
    writeFileSync(path.join(reportDirectory, "report.json"), JSON.stringify({ passed: false, error: String(error) }, null, 2));
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
