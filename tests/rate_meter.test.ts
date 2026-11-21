import { describe, expect, it } from 'vitest';
import { RateMeter } from '../server/rate_meter';

describe('RateMeter', () => {
  it('counts a sliding 60 s window', () => {
    let now = 0;
    const m = new RateMeter(100, 100_000, 0.1, () => now);
    m.record(1000);
    now = 30_000;
    m.record(2000);
    expect(m.snapshot()).toMatchObject({ rpm: 2, tpm: 3000 });
    now = 60_001;
    expect(m.snapshot()).toMatchObject({ rpm: 1, tpm: 2000 });
  });

  it('asks the caller to wait when the TPM budget (with headroom) is full', () => {
    let now = 0;
    const m = new RateMeter(100, 10_000, 0.1, () => now);
    m.record(5000);
    now = 10_000;
    m.record(3000);
    expect(m.delayFor(500)).toBe(0); // 8.5K <= 9K
    expect(m.delayFor(2000)).toBe(50_000); // must wait for the first event to expire at t=60 s
    expect(() => m.delayFor(20_000)).toThrow(/exceeds/);
  });

  it('asks the caller to wait when the RPM budget is full', () => {
    let now = 0;
    const m = new RateMeter(10, 1e9, 0.1, () => now);
    for (let k = 0; k < 9; k++) { now = k * 1000; m.record(1); }
    expect(m.delayFor(1)).toBe(60_000 - 8000);
  });
});
