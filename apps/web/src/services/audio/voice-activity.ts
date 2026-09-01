export type VoiceActivityState = {
  speaking: boolean;
  lastVoiceAt: number;
};

export type VoiceActivityOptions = {
  startThreshold: number;
  continueThreshold: number;
  releaseMs: number;
  sampleIntervalMs: number;
};

const DEFAULT_OPTIONS: VoiceActivityOptions = {
  startThreshold: 0.018,
  continueThreshold: 0.009,
  releaseMs: 240,
  sampleIntervalMs: 50,
};

let sharedContext: AudioContext | undefined;
let sharedContextUsers = 0;

export function rootMeanSquare(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    energy += sample * sample;
  }
  return Math.sqrt(energy / samples.length);
}

export function nextVoiceActivityState(
  state: VoiceActivityState,
  level: number,
  now: number,
  options: Pick<VoiceActivityOptions, "startThreshold" | "continueThreshold" | "releaseMs"> = DEFAULT_OPTIONS,
): VoiceActivityState {
  if (!state.speaking) {
    return level >= options.startThreshold
      ? { speaking: true, lastVoiceAt: now }
      : state;
  }
  if (level >= options.continueThreshold) return { speaking: true, lastVoiceAt: now };
  if (now - state.lastVoiceAt >= options.releaseMs) return { speaking: false, lastVoiceAt: state.lastVoiceAt };
  return state;
}

export function observeVoiceActivity(
  stream: MediaStream,
  onChange: (speaking: boolean) => void,
  overrides: Partial<VoiceActivityOptions> = {},
): () => void {
  if (typeof AudioContext === "undefined" || !stream.getAudioTracks().some((track) => track.readyState === "live")) {
    return () => undefined;
  }
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  let context: AudioContext;
  try {
    context = acquireSharedContext();
  } catch (error) {
    console.warn("Não foi possível iniciar a análise do microfone.", error);
    return () => undefined;
  }
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.15;
    source.connect(analyser);
  } catch (error) {
    releaseSharedContext(context);
    console.warn("Não foi possível observar a atividade do microfone.", error);
    return () => undefined;
  }

  const samples = new Float32Array(analyser.fftSize);
  let state: VoiceActivityState = { speaking: false, lastVoiceAt: 0 };
  let reported = false;
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    const next = nextVoiceActivityState(state, rootMeanSquare(samples), performance.now(), options);
    state = next;
    if (next.speaking === reported) return;
    reported = next.speaking;
    onChange(reported);
  }, options.sampleIntervalMs);
  if (context.state === "suspended") void context.resume().catch(() => undefined);

  return () => {
    window.clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
    releaseSharedContext(context);
  };
}

function acquireSharedContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") sharedContext = new AudioContext({ latencyHint: "interactive" });
  sharedContextUsers += 1;
  return sharedContext;
}

function releaseSharedContext(context: AudioContext): void {
  sharedContextUsers = Math.max(0, sharedContextUsers - 1);
  if (sharedContextUsers > 0 || sharedContext !== context) return;
  sharedContext = undefined;
  void context.close().catch(() => undefined);
}
