/**
 * Frequency-domain fields from recorded time-domain planes.
 *
 * The solver records E on a few planes every `stepsBetweenFrames` steps over
 * the whole run. A single-frequency DFT of those samples gives the complex
 * field (phasor) at that frequency, the same quantity a frequency-domain
 * commercial frequency-domain solver plots. The run already rings down to near zero, so no
 * window is applied (it would bias the field toward early times).
 */
export interface PlanePhasor {
  re: Float32Array;
  im: Float32Array;
}

export function planePhasor(frames: Float32Array[], frameTimesSec: number[], frequencyHz: number): PlanePhasor {
  if (frames.length === 0) throw new Error('planePhasor: no frames recorded');
  if (frames.length !== frameTimesSec.length) throw new Error('planePhasor: frames and times differ in length');
  const cellCount = frames[0].length;
  const re = new Float32Array(cellCount);
  const im = new Float32Array(cellCount);
  const omega = 2 * Math.PI * frequencyHz;
  frames.forEach((frame, n) => {
    const c = Math.cos(omega * frameTimesSec[n]);
    const s = -Math.sin(omega * frameTimesSec[n]);
    for (let cell = 0; cell < cellCount; cell++) {
      re[cell] += frame[cell] * c;
      im[cell] += frame[cell] * s;
    }
  });
  return { re, im };
}

/** Instantaneous field Re{P e^{j phase}} for the phase animation. */
export function instantaneousField(p: PlanePhasor, phaseRad: number, out: Float32Array): Float32Array {
  const c = Math.cos(phaseRad);
  const s = Math.sin(phaseRad);
  for (let cell = 0; cell < out.length; cell++) out[cell] = p.re[cell] * c - p.im[cell] * s;
  return out;
}

export function phasorMagnitude(p: PlanePhasor): Float32Array {
  const out = new Float32Array(p.re.length);
  for (let cell = 0; cell < out.length; cell++) out[cell] = Math.hypot(p.re[cell], p.im[cell]);
  return out;
}
