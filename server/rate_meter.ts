/**
 * Sliding 60 s window over Cerebras requests and tokens, so the demo never
 * trips the hackathon limits (100 RPM, 100K TPM per participant).
 *
 * Saturday's OpenClaw/Kimi loop calls `waitForBudget(estimate)` before each
 * request and `record(actualTokens)` after it. The bridge exposes the numbers
 * at GET /api/meter and pushes them to the browser HUD.
 */
export interface MeterSnapshot {
  rpm: number;
  tpm: number;
  rpmCap: number;
  tpmCap: number;
}

export class RateMeter {
  private events: Array<{ t: number; tokens: number }> = [];

  constructor(
    readonly rpmCap = 100,
    readonly tpmCap = 100_000,
    /** Keep this fraction of each cap in reserve (retries, clock skew with the server's window). */
    readonly headroom = 0.1,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const cutoff = this.now() - 60_000;
    while (this.events.length && this.events[0].t <= cutoff) this.events.shift();
  }

  record(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error('tokens must be a non-negative number');
    this.events.push({ t: this.now(), tokens });
  }

  snapshot(): MeterSnapshot {
    this.prune();
    return {
      rpm: this.events.length,
      tpm: this.events.reduce((s, e) => s + e.tokens, 0),
      rpmCap: this.rpmCap,
      tpmCap: this.tpmCap,
    };
  }

  /** Milliseconds to wait before a request of `estTokens` fits under both caps (0 = go now). */
  delayFor(estTokens: number): number {
    this.prune();
    const rpmLimit = Math.floor(this.rpmCap * (1 - this.headroom));
    const tpmLimit = Math.floor(this.tpmCap * (1 - this.headroom));
    if (estTokens > tpmLimit) throw new Error(`a single request of ${estTokens} tokens exceeds the TPM budget`);
    let count = this.events.length;
    let tokens = this.events.reduce((s, e) => s + e.tokens, 0);
    // Walk forward through expiries until both limits fit.
    for (const e of this.events) {
      if (count + 1 <= rpmLimit && tokens + estTokens <= tpmLimit) break;
      count -= 1;
      tokens -= e.tokens;
      if (count + 1 <= rpmLimit && tokens + estTokens <= tpmLimit) return Math.max(0, e.t + 60_000 - this.now());
    }
    return 0;
  }

  async waitForBudget(estTokens: number): Promise<void> {
    const ms = this.delayFor(estTokens);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms + 5));
  }
}
