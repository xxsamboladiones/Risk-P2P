export class PolicyTimer {
  private handle?: ReturnType<typeof setTimeout>;
  private cadence: number | null = null;

  constructor(private readonly callback: () => void) {}

  setCadence(cadence: number | null): void {
    this.stop();
    this.cadence = cadence;
    if (cadence !== null) this.schedule();
  }

  stop(): void {
    if (this.handle !== undefined) clearTimeout(this.handle);
    this.handle = undefined;
  }

  private schedule(): void {
    const cadence = this.cadence;
    if (cadence === null) return;
    this.handle = setTimeout(() => {
      this.callback();
      this.schedule();
    }, cadence);
  }
}
