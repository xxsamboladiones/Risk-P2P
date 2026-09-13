// Verificação local com WebRTC real e fontes sintéticas; não acessa dispositivos
// de captura, contas ou servidores externos. Execute com Electron.
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require("node:fs");
const path = require("node:path");
const ts = require("../apps/web/node_modules/typescript");
const root = path.resolve(__dirname, "..");
const output = path.join(root, ".risk/late-join-screen");
mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, `profile-${process.pid}`));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function bundleTransport() {
  const modules = {};
  function include(file) {
    const id = path.relative(root, file).replaceAll("\\", "/");
    if (modules[id]) return id;
    modules[id] = "";
    if (file.endsWith(".json")) { modules[id] = `module.exports = ${readFileSync(file, "utf8")};`; return id; }
    let code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    code = code.replace(/require\("([^"]+)"\)/g, (_, specifier) => {
      const target = specifier === "@risk/shared"
        ? path.join(root, "packages/shared/src/index.ts")
        : specifier === "@risk/protocol" ? path.join(root, "packages/protocol/src/index.ts")
        : path.resolve(path.dirname(file), specifier);
      const resolved = existsSync(`${target}.ts`) ? `${target}.ts` : target;
      return `require(${JSON.stringify(include(resolved))})`;
    });
    modules[id] = code;
    return id;
  }
  const entry = include(path.join(root, "packages/rtc/src/transport/mesh.ts"));
  return `(() => {
    const sources = ${JSON.stringify(modules)}, cache = {};
    function require(id) {
      if (!cache[id]) {
        const module = cache[id] = { exports: {} };
        new Function('require', 'module', 'exports', sources[id])(require, module, module.exports);
      }
      return cache[id].exports;
    }
    window.MeshWebRTCTransport = require(${JSON.stringify(entry)}).MeshWebRTCTransport;
  })();`;
}

async function verify() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];
  for (const presenterId of ["peer-a", "peer-z"]) {
    for (const presenterAuthDelay of [0, 75, 150, -1]) {
      console.log("late-join scenario", presenterId, presenterAuthDelay);
      const peers = new Map();
      const videos = new Map();
      const errors = [];
      const tasks = new Set();
      const schedule = (callback, delay) => {
        const timer = setTimeout(() => { tasks.delete(timer); callback(); }, delay);
        tasks.add(timer);
      };
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const microphone = audio.createMediaStreamDestination();
      oscillator.connect(microphone);
      oscillator.start();
      await audio.resume();
      console.log("synthetic audio ready");
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext("2d");
      let frame = 0;
      const draw = setInterval(() => {
        ctx.fillStyle = frame++ % 2 ? "#abcdef" : "#334455";
        ctx.fillRect(0, 0, 320, 180);
      }, 33);
      const screen = canvas.captureStream(30);
      const screenAudioContext = new AudioContext();
      const screenAudio = screenAudioContext.createMediaStreamDestination();
      if (presenterAuthDelay === 75) await screenAudioContext.suspend();
      else {
        const tone = screenAudioContext.createOscillator();
        tone.connect(screenAudio);
        tone.start();
        await screenAudioContext.resume();
      }
      screen.addTrack(screenAudio.stream.getAudioTracks()[0]);
      const received = [];
      const makePeer = (id) => {
        const deliver = (remoteId, method, payload) => {
          schedule(() => { void peers.get(remoteId)[method](id, payload).catch((error) => errors.push(String(error))); }, 10);
        };
        const transport = new window.MeshWebRTCTransport(id, [], {
          sendOffer: (remoteId, description) => deliver(remoteId, "acceptOffer", description),
          sendAnswer: (remoteId, description) => deliver(remoteId, "acceptAnswer", description),
          sendIce: (remoteId, candidate) => deliver(remoteId, "addIceCandidate", candidate),
          onConnectionState: () => {},
          onDataMessage: () => {},
          onNegotiationError: (_remoteId, error) => errors.push(String(error)),
          onDataState: (remoteId, state) => {
            if (state !== "open") return;
            if (presenterAuthDelay === -1 && id === "peer-n" && remoteId === presenterId) return;
            schedule(() => { void transport.authorizePeerMedia(remoteId).catch((error) => errors.push(String(error))); },
              id === presenterId ? Math.max(0, presenterAuthDelay) : 150 - Math.max(0, presenterAuthDelay));
          },
          onRemoteStream: (remoteId, stream) => {
            window.testRemoteStream?.(id, remoteId, stream, remoteId === presenterId ? screen.id : "unknown");
            received.push({ id, remoteId, streamId: stream.id, tracks: stream.getTracks().map((t) => ({ kind: t.kind, enabled: t.enabled, muted: t.muted })) });
            if (remoteId !== presenterId || stream.id !== screen.id) return;
            if (videos.has(id)) return;
            const video = document.createElement("video");
            video.autoplay = true; video.muted = true;
            video.srcObject = stream;
            document.body.append(video);
            void video.play().catch((error) => errors.push(String(error)));
            videos.set(id, video);
          },
        });
        transport.requireMediaAuthorization();
        peers.set(id, transport);
        return transport;
      };
      const waitForVideo = async (id) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const video = window.testRemoteStream ? document.getElementById(`${id}-${presenterId}`)?.querySelector('video') : videos.get(id);
          if (video?.getVideoPlaybackQuality().totalVideoFrames >= 3 && video.readyState >= 2) {
            const sample = document.createElement("canvas");
            sample.width = sample.height = 1;
            const context = sample.getContext("2d");
            context.drawImage(video, 0, 0, 1, 1);
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
            if (r + g + b > 100) return true; // Faixas desativadas também geram frames, mas pretos.
          }
          await sleep(50);
        }
        return false;
      };
      try {
        const presenter = makePeer(presenterId);
        const existing = makePeer("peer-m");
        await presenter.publishTrack(microphone.stream.getAudioTracks()[0], microphone.stream);
        await Promise.all([
          presenter.connect("peer-m", presenterId < "peer-m"),
          existing.connect(presenterId, "peer-m" < presenterId),
        ]);
        await sleep(400);
        await Promise.all(screen.getTracks().map((track) => presenter.publishTrack(track, screen, { source: "screen" })));
        const existingReceived = await waitForVideo("peer-m");
        console.log("existing receiver", existingReceived);
        const late = makePeer("peer-n");
        await late.publishTrack(microphone.stream.getAudioTracks()[0], microphone.stream);
        const lateScreen = new MediaStream(screen.getTracks().map((track) => track.clone()));
        await Promise.all(lateScreen.getTracks().map((track) => late.publishTrack(track, lateScreen, { source: "screen" })));
        await Promise.all([
          presenter.connect("peer-n", presenterId < "peer-n"),
          late.connect(presenterId, "peer-n" < presenterId),
          existing.connect("peer-n", true),
          late.connect("peer-m", false),
        ]);
        if (presenterAuthDelay === -1) {
          // Exercita uma renegociação durante a entrada: o receptor já tem a
          // faixa provisória, mas ainda aguarda sua autorização de mídia.
          let pending;
          for (let i = 0; i < 200; i++) {
            pending = late.pendingRemoteStreams.get(presenterId)?.get(screen.id);
            if (pending?.getVideoTracks().length) break;
            await sleep(10);
          }
          if (!pending?.getVideoTracks().length) throw new Error("Não recebeu vídeo provisório antes da autorização");
          const videoTrack = screen.getVideoTracks()[0];
          void presenter.unpublishTrack(videoTrack).catch((error) => errors.push(String(error)));
          for (let i = 0; i < 200 && pending.getVideoTracks().length; i++) await sleep(10);
          if (pending.getVideoTracks().length) throw new Error("Renegociação não retirou a faixa provisória");
          void late.authorizePeerMedia(presenterId).catch((error) => errors.push(String(error)));
          void presenter.publishTrack(videoTrack, screen, { source: "screen" }).catch((error) => errors.push(String(error)));
        }
        const lateReceived = await waitForVideo("peer-n");
        console.log("late receiver", lateReceived);
        results.push({ presenterId, presenterAuthDelay, existingReceived, lateReceived, errors,
          receivedFrames: videos.get("peer-n")?.getVideoPlaybackQuality().totalVideoFrames ?? 0, received,
          ui: [...document.querySelectorAll('#root video')].map(v => ({frames:v.getVideoPlaybackQuality().totalVideoFrames,ready:v.readyState,paused:v.paused,stream:v.srcObject?.id})) });
        lateScreen.getTracks().forEach((track) => track.stop());
      } finally {
        tasks.forEach(clearTimeout);
        // As conexões fecham imediatamente; limita somente a espera pela fila
        // de parâmetros dos senders que o Chromium está descartando no cleanup.
        await Promise.race([Promise.all([...peers.values()].map((peer) => peer.disconnect())), sleep(1000)]);
        clearInterval(draw);
        screen.getTracks().forEach((track) => track.stop());
        microphone.stream.getTracks().forEach((track) => track.stop());
        oscillator.stop();
        await Promise.race([audio.close(), sleep(1000)]);
        await Promise.race([screenAudioContext.close(), sleep(1000)]);
        videos.forEach((video) => video.remove());
        window.resetUI?.();
      }
    }
  }
  return { passed: results.every((result) => result.existingReceived && result.lateReceived && !result.errors.length), results };
}

const timeout = setTimeout(() => {
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: false, error: "Verification timed out" }));
  app.exit(2);
}, 55000);
app.whenReady().then(async () => {
  console.log("electron ready");
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  window.webContents.on("console-message", (_event, _level, message) => console.log(message));
  window.webContents.setAudioMuted(true);
  try {
    await window.loadURL("data:text/html,<html><body><div id='root'></div></body></html>");
    console.log("page loaded");
    await window.webContents.executeJavaScript(bundleTransport());
    if (process.env.RISK_VERIFY_SCREEN_UI === "1") await window.webContents.executeJavaScript(readFileSync(path.join(output, "ui.js"), "utf8"));
    console.log("transport loaded");
    const report = await window.webContents.executeJavaScript(`(${verify.toString()})()`);
    writeFileSync(path.join(output, "report.json"), JSON.stringify({ electron: process.versions.electron, ...report }, null, 2));
    console.log(JSON.stringify(report));
    clearTimeout(timeout);
    app.exit(report.passed ? 0 : 1);
  } catch (error) {
    writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: false, error: String(error) }, null, 2));
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
