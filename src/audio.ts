/** A short, locally generated chime. No remote audio or notification permission. */
export class TimerAudio {
  private context: AudioContext | null = null;

  async unlock(): Promise<boolean> {
    try {
      this.context ??= new AudioContext();
      if (this.context.state === "suspended") await this.context.resume();
      return this.context.state === "running";
    } catch { return false; }
  }

  chime(): void {
    const context = this.context;
    if (!context || context.state !== "running") return;
    try {
      for (const [index, frequency] of [660, 880, 990].entries()) {
        const start = context.currentTime + index * 0.17;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.1, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.65);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.7);
      }
    } catch { /* Audio must never interrupt the timer. */ }
  }

  dispose(): void {
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => {});
  }
}
