import type { RunControl } from './types';

/**
 * The energy-stop decision, shared by the CPU and GPU solvers. Feed it the
 * field energy at each check; it tracks the peak and says when the run may stop.
 */
export class EnergyStop {
  private peakEnergy = 0;
  /** Decay from the peak at the last check, in dB. NaN until the first check. */
  decayDb = NaN;
  /** True once the requested decay was reached after the source ended. */
  reached = false;

  constructor(private readonly control: RunControl, private readonly sourceEndStep: number) {}

  /** Record the energy after `stepsDone` steps; returns true when the run should stop. */
  check(stepsDone: number, energy: number): boolean {
    // A diverged run would otherwise read as "decayed to nothing" and stop as if it had converged.
    if (!Number.isFinite(energy)) throw new Error(`The field energy became ${energy} after ${stepsDone} steps: the solve diverged. Check for a cell far smaller than its neighbors or a material constant that is not physical.`);
    this.peakEnergy = Math.max(this.peakEnergy, energy);
    // No field at all once the source has run means the solver did nothing (on the GPU, a failed submit reads
    // back zeros), not that the fields decayed: stopping here would show a flat 0 dB result as converged.
    if (this.peakEnergy === 0 && stepsDone - 1 >= this.sourceEndStep) throw new Error(`The field energy is still zero after ${stepsDone} steps, with the source finished: the solver produced no fields. On the GPU this usually means the device ran out of memory or rejected a buffer; try a coarser mesh or "CPU only".`);
    this.decayDb = energy > 0 ? 10 * Math.log10(this.peakEnergy / energy) : Infinity;
    const target = this.control.stopAtEnergyDecayDb;
    this.reached = target !== null && stepsDone - 1 >= this.sourceEndStep && this.decayDb >= target;
    return this.reached;
  }
}
