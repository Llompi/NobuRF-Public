import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** USD per million tokens. */
export interface Price {
  inputPerM: number;
  outputPerM: number;
}

export class SpendCapError extends Error {}

interface Ledger {
  /** Per provider: USD this tool has spent on it, ever, and on how many calls. */
  providers: Record<string, { spent_usd: number; calls: number }>;
}

/** Shared by every clone on a machine, so two checkouts cannot each spend up to the cap. */
export const DEFAULT_LEDGER = join(homedir(), '.noburf', 'spend.json');

/** A lock older than this was left by a crashed process. Ledger updates take milliseconds. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/**
 * Ceilings no setting can raise: the owner's credit on each provider is $5 with no
 * auto-recharge, so this tool may spend at most $4 of it over its lifetime and
 * $1 in one run.
 */
export const MAX_PROVIDER_CAP_USD = 4;
export const MAX_RUN_CAP_USD = 1;

const isUsd = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** A held reservation: the worst case already charged to the ledger, settled to the actual cost after the call. */
export interface Reservation {
  readonly worstCaseUsd: number;
  settled: boolean;
}

/**
 * Hard spend limits for model calls. Before a call, its worst case (the whole
 * prompt plus the largest completion allowed) is checked against the run cap
 * and the provider's lifetime cap and charged to a ledger file at once, under
 * a lock, so concurrent runs cannot both spend the same headroom. After the
 * call the charge is corrected to the actual cost. A call that fails in a way
 * that may still have been billed (connection lost after sending, an
 * unreadable body) keeps its worst-case charge.
 *
 * The ledger only sees spend through this tool, on this machine: another
 * machine, a fresh container, OpenClaw or any other script on the same key
 * starts from or adds nothing to it. It is a guard against our own loops
 * running away; the provider-side limit is the real stop.
 */
export class SpendGuard {
  private runSpent = 0;

  constructor(
    readonly provider: string,
    readonly price: Price,
    readonly runCapUsd: number,
    readonly providerCapUsd: number,
    readonly ledgerPath: string = DEFAULT_LEDGER,
  ) {
    // A price of 0 would make every worst case $0: the guard would never refuse and the ledger would record nothing.
    if (!(isUsd(price.inputPerM) && price.inputPerM > 0) || !(isUsd(price.outputPerM) && price.outputPerM > 0)) {
      throw new Error(`prices must be positive numbers (USD per million tokens), got ${JSON.stringify(price)}`);
    }
    if (!(isUsd(runCapUsd) && runCapUsd > 0 && runCapUsd <= MAX_RUN_CAP_USD)) throw new Error(`the run cap must be more than $0 and at most $${MAX_RUN_CAP_USD}, got ${runCapUsd}`);
    if (!(isUsd(providerCapUsd) && providerCapUsd > 0 && providerCapUsd <= MAX_PROVIDER_CAP_USD)) {
      throw new Error(`the provider cap must be more than $0 and at most $${MAX_PROVIDER_CAP_USD}, got ${providerCapUsd}`);
    }
  }

  get spentThisRun(): number {
    return this.runSpent;
  }

  spentEver(): number {
    return this.read().providers[this.provider]?.spent_usd ?? 0;
  }

  costUsd(promptTokens: number, completionTokens: number): number {
    const cost = (promptTokens * this.price.inputPerM + completionTokens * this.price.outputPerM) / 1e6;
    if (!isUsd(cost)) throw new Error(`cost of ${promptTokens} + ${completionTokens} tokens is not a valid amount`);
    return cost;
  }

  /** Charge the worst case now, or throw SpendCapError if it could break a cap. */
  reserve(worstCaseUsd: number): Reservation {
    if (!isUsd(worstCaseUsd)) throw new Error(`worst case ${worstCaseUsd} is not a valid amount`);
    if (this.runSpent + worstCaseUsd > this.runCapUsd) {
      throw new SpendCapError(`run spend cap: $${this.runSpent.toFixed(4)} spent this run, the next call could cost up to $${worstCaseUsd.toFixed(4)}, cap $${this.runCapUsd}`);
    }
    this.update((entry) => {
      if (entry.spent_usd + worstCaseUsd > this.providerCapUsd) {
        throw new SpendCapError(`${this.provider} spend cap: $${entry.spent_usd.toFixed(4)} spent so far (ledger ${this.ledgerPath}), the next call could cost up to $${worstCaseUsd.toFixed(4)}, cap $${this.providerCapUsd}`);
      }
      entry.spent_usd += worstCaseUsd;
      entry.calls += 1;
    });
    this.runSpent += worstCaseUsd;
    return { worstCaseUsd, settled: false };
  }

  /** Replace a reservation's worst case by the actual cost (never more than the worst case). */
  settle(r: Reservation, actualUsd: number): void {
    if (r.settled) throw new Error('reservation already settled');
    if (!isUsd(actualUsd)) throw new Error(`actual cost ${actualUsd} is not a valid amount`);
    r.settled = true;
    // A provider reporting more than the worst case means our estimate was wrong: charge what it says,
    // and say so, because the cap check before the next call relied on that estimate.
    const delta = actualUsd - r.worstCaseUsd;
    if (delta > 0) console.error(`${this.provider}: a call cost $${actualUsd.toFixed(4)}, more than its reserved worst case $${r.worstCaseUsd.toFixed(4)}; the spend cap can be passed by up to one call`);
    this.update((entry) => {
      entry.spent_usd = Math.max(0, entry.spent_usd + delta);
    });
    this.runSpent = Math.max(0, this.runSpent + delta);
  }

  private update(change: (entry: Ledger['providers'][string]) => void): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const release = this.lock();
    try {
      const ledger = this.read();
      const entry = (ledger.providers[this.provider] ??= { spent_usd: 0, calls: 0 });
      change(entry);
      const tmp = `${this.ledgerPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
      renameSync(tmp, this.ledgerPath);
    } finally {
      release();
    }
  }

  private lock(): () => void {
    const lockPath = `${this.ledgerPath}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lockPath, 'wx'));
        return () => unlinkSync(lockPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) unlinkSync(lockPath);
      } catch {
        // gone already: try again
      }
      if (Date.now() > deadline) throw new Error(`spend ledger ${this.ledgerPath} is locked (${lockPath}); is another run stuck?`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }

  private read(): Ledger {
    let text: string;
    try {
      text = readFileSync(this.ledgerPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { providers: {} };
      throw e;
    }
    // A corrupt ledger must stop spending, not reset it to zero.
    const ledger = JSON.parse(text) as Ledger;
    const ok = typeof ledger?.providers === 'object' && ledger.providers !== null &&
      Object.values(ledger.providers).every((p) => isUsd(p?.spent_usd) && Number.isInteger(p?.calls));
    if (!ok) throw new Error(`spend ledger ${this.ledgerPath} is not readable; fix or delete it by hand`);
    return ledger;
  }
}
