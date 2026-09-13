type Receiver = RTCRtpReceiver & { jitterBufferTarget?: number | null };

/** Apply to audio and video together: synchronized receivers share the larger target. */
export class GamePlayout {
  private previous = new Map<Receiver, number | null>();
  apply(receivers: RTCRtpReceiver[], targetMs = 0): void {
    for (const receiver of receivers as Receiver[]) {
      if (!("jitterBufferTarget" in receiver)) continue;
      try {
        if (!this.previous.has(receiver)) this.previous.set(receiver, receiver.jitterBufferTarget ?? null);
        receiver.jitterBufferTarget = targetMs;
      } catch { /* Optional browser capability; keep normal playback if unsupported. */ }
    }
  }
  restore(): void {
    for (const [receiver, target] of this.previous) {
      try { receiver.jitterBufferTarget = target; } catch { /* Receiver may have closed. */ }
    }
    this.previous.clear();
  }
}
