import { describe, expect, it } from 'vitest';
import { EnergyStop } from '../src/engine/energy_stop';

const control = { maxSteps: 1000, stopAtEnergyDecayDb: 30, energyCheckEverySteps: 100 };

describe('EnergyStop', () => {
  it('measures decay from the peak, not from the first check', () => {
    const stop = new EnergyStop(control, 0);
    stop.check(100, 1);
    stop.check(200, 100);
    expect(stop.check(300, 1)).toBe(false);
    expect(stop.decayDb).toBeCloseTo(20, 12);
  });

  it('stops only after the source has ended', () => {
    const stop = new EnergyStop(control, 250);
    stop.check(100, 1e6);
    expect(stop.check(200, 1)).toBe(false); // 60 dB down, but the source still runs
    expect(stop.reached).toBe(false);
    expect(stop.check(300, 1)).toBe(true);
    expect(stop.reached).toBe(true);
  });

  it('counts a target reached on the last step as reached', () => {
    // The run ends at maxSteps either way; the flag must still say the decay was met.
    const stop = new EnergyStop({ ...control, maxSteps: 200 }, 0);
    stop.check(100, 1e6);
    expect(stop.check(200, 1)).toBe(true);
    expect(stop.reached).toBe(true);
  });

  it('reports NaN until the first check and never stops a fixed run', () => {
    const stop = new EnergyStop({ ...control, stopAtEnergyDecayDb: null }, 0);
    expect(stop.decayDb).toBeNaN();
    stop.check(100, 1e6);
    expect(stop.check(200, 0)).toBe(false);
    expect(stop.decayDb).toBe(Infinity);
  });

  it('refuses a diverged run instead of reading NaN energy as fully decayed', () => {
    const stop = new EnergyStop(control, 0);
    stop.check(100, 1);
    expect(() => stop.check(200, NaN)).toThrow(/diverged/);
    expect(() => new EnergyStop(control, 0).check(100, Infinity)).toThrow(/diverged/);
  });

  it('refuses a run that never produced any field', () => {
    // A failed GPU submit reads back zeros; that must not read as "decayed" and stop as converged.
    const stop = new EnergyStop(control, 150);
    expect(stop.check(100, 0)).toBe(false); // the source may not have injected anything yet
    expect(() => stop.check(200, 0)).toThrow(/still zero/);
  });
});
