import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWasmSimdPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

export type RnnoiseMicrophone = {
  track: MediaStreamTrack;
  stop(): Promise<void>;
};

type RnnoiseNode = AudioWorkletNode & { destroy(): void };
type RnnoiseModule = typeof import("@sapphi-red/web-noise-suppressor");

let modulePromise: Promise<RnnoiseModule> | undefined;
let wasmBinaryPromise: Promise<ArrayBuffer> | undefined;

function loadModule(): Promise<RnnoiseModule> {
  // Importação lazy: os testes Vitest rodam em Node, onde AudioWorkletNode não
  // existe. O módulo só deve ser avaliado no renderer quando RNNoise for usado.
  modulePromise ??= import("@sapphi-red/web-noise-suppressor");
  return modulePromise;
}

async function loadWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadModule().then(({ loadRnnoise }) => loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseWasmSimdPath,
    }));
  }
  return wasmBinaryPromise;
}

/**
 * Processa o microfone localmente com RNNoise em um AudioWorklet.
 *
 * O RNNoise usado pelo worklet opera a 48 kHz. O MediaStreamAudioSourceNode
 * faz a conversão da entrada para a taxa do AudioContext e o WebRTC recebe
 * apenas a track produzida pelo MediaStreamAudioDestinationNode.
 */
export async function createRnnoiseMicrophone(inputStream: MediaStream): Promise<RnnoiseMicrophone> {
  const context = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
  let source: MediaStreamAudioSourceNode | undefined;
  let suppressor: RnnoiseNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;

  try {
    if (context.sampleRate !== 48_000) {
      throw new Error(`RNNoise requer AudioContext a 48 kHz; recebido ${context.sampleRate} Hz.`);
    }

    const [{ RnnoiseWorkletNode }, wasmBinary] = await Promise.all([
      loadModule(),
      loadWasmBinary(),
      context.audioWorklet.addModule(rnnoiseWorkletPath),
    ]);

    source = context.createMediaStreamSource(inputStream);
    suppressor = new RnnoiseWorkletNode(context, {
      wasmBinary,
      maxChannels: 1,
    });
    destination = context.createMediaStreamDestination();
    source.connect(suppressor).connect(destination);

    await context.resume();
    const outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) throw new Error("RNNoise não produziu uma track de áudio.");
    outputTrack.contentHint = "speech";

    let stopped = false;
    return {
      track: outputTrack,
      async stop() {
        if (stopped) return;
        stopped = true;
        outputTrack.stop();
        source?.disconnect();
        suppressor?.disconnect();
        suppressor?.destroy();
        destination?.disconnect();
        await context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    source?.disconnect();
    suppressor?.disconnect();
    suppressor?.destroy();
    destination?.disconnect();
    await context.close().catch(() => undefined);
    throw error;
  }
}
