/**
 * One gate for machine probes the server can trigger repeatedly (model
 * detection, account-usage refresh). Each spawns runtime CLIs, and a page that
 * asks again before the last answer arrives used to start a second copy: on a
 * Mac where `cursor-agent models` takes ~5s, three overlapping probes each
 * slowed to the 15s deadline and were all killed (artin 2026-09-28).
 *
 * - Same key while one is in flight: the caller joins it and gets the same
 *   result; no second process.
 * - Different keys: at most `maxConcurrent` run at once; the rest wait in FIFO
 *   order for a free slot. The daemon runs it uncapped: a queued probe's wait
 *   counts against the server's 20s request budget, so a cap would trade the
 *   overlap bug for silent server-side timeouts (Stone, review of #8549). The
 *   incident was same-key overlap, which the join alone removes.
 * - A task that throws settles every joined caller with that error and frees
 *   the key and the slot, so the next request starts fresh.
 */
export class ProbeGate {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly waiting: Array<() => void> = [];
  private running = 0;

  constructor(private readonly maxConcurrent = Number.POSITIVE_INFINITY) {
    if (!(maxConcurrent === Number.POSITIVE_INFINITY || (Number.isInteger(maxConcurrent) && maxConcurrent >= 1))) {
      throw new Error("ProbeGate maxConcurrent must be a positive integer or Infinity");
    }
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const started = this.acquire()
      .then(() => task())
      .finally(() => {
        this.inFlight.delete(key);
        this.release();
      });
    this.inFlight.set(key, started);
    return started;
  }

  /** In-flight keys, for tests and diagnostics. */
  get activeKeys(): string[] {
    return [...this.inFlight.keys()];
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}
