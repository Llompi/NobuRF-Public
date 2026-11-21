/**
 * Stripline family: a zero-thickness strip centred between two ground planes
 * in one dielectric, on graded meshes through the project-file path users
 * take (parseProject, rasterise). The strip's two copper edges are where a
 * sheet-edge error shows.
 *
 * Truths:
 *   - Z0 = Cohn's exact conformal-map formula (closed_forms.ts), within the
 *     convergence band of a refinement study, and the error must fall at
 *     second order (no first-order term).
 *   - beta = the 1D Yee dispersion relation, exactly at every level (the
 *     discrete scheme has an exact TEM mode in a uniform fill: E_t is the
 *     discrete gradient of a discrete static potential, so only the
 *     longitudinal differences disperse).
 *   - Z0 does not change when the board is translated by a fraction of a
 *     cell, mirrored, or scaled with its mesh (the mesh must follow exactly).
 *
 * Measurement (not the solver's port code): a soft source column at the near
 * end drives the strip against both grounds at once (Ez pushed down below the
 * strip and up above it), so by the up-down mirror symmetry only the
 * stripline mode is launched, never the parallel-plate mode between the two
 * unconnected grounds. V is the line integral of Ez from the strip to each
 * ground at two neighbouring y nodes, I the Ampere loop of H around the strip
 * in the plane between them. The records are gated to the forward pulse; the
 * far-end echo arrives after the gate. The one lumped port the project file
 * needs terminates the far end and is never excited.
 */
import { C0, ETA0, timestepSec } from '../../../src/engine/config';
import { CpuFdtd } from '../../../src/engine/fdtd_cpu';
import { cellWidth, dualWidth } from '../../../src/engine/mesh';
import { sourceParams, sourceValue } from '../../../src/engine/source';
import { rasterise } from '../../../src/project/rasterise';
import { linesMap, refine, scale, toProject, translate, mirrorX, type BoardSpec } from '../board_spec';
import { cohnStriplineZ0, yeeTemBeta } from '../closed_forms';
import { compare, dft, observedOrderAgainstExact, orderVerdict, richardson, type Check, type Level } from '../measure';
import type { Rng } from '../rng';
import { roundoffError, striplineWidthModelError, TEM_EXTRACTION_ERROR, MIN_OBSERVED_ORDER, MAX_OBSERVED_ORDER } from '../tolerances';

const FAMILY = 'stripline';

interface StriplineCase {
  spec: BoardSpec;
  widthMm: number;
  groundSpacingMm: number;
  epsR: number;
  stripCentreMm: number;
  /** Narrowest ground plane past a strip edge. */
  gapMm: number;
  /** Near-end source and measurement plane positions along the line. */
  sourceYMm: number;
  measureYMm: number;
}

/** Draw one case. Ranges are what a user might set; nothing is chosen from solver results. */
export function drawStripline(rng: Rng, name: string): StriplineCase {
  const b = rng.uniform(1.5, 3);
  const widthMm = b * rng.uniform(0.4, 2);
  const epsR = rng.uniform(1, 6);
  const stripCentreMm = rng.uniform(-b / 2, b / 2);
  const minGap = 2 * b;
  const halfBoard = widthMm / 2 + minGap + b / 2;
  const gapMm = halfBoard - widthMm / 2 - Math.abs(stripCentreMm);
  // Band: well below the first higher-order mode of the plates (about c / (b sqrt(eps_r)) for modes the symmetric source can launch).
  const fMaxGHz = (0.2 * C0) / (b * 1e-3 * Math.sqrt(epsR)) / 1e9;
  const fMinGHz = 0.15 * fMaxGHz;
  // Pulse length in space: the source spans about 7.22 tau, tau = 1 / (pi * span).
  const v = C0 / Math.sqrt(epsR);
  const pulseMm = ((7.22 / (Math.PI * (fMaxGHz - fMinGHz) * 1e9)) * v) * 1e3;
  // The source also launches a wave toward the near end; its echo must reach the plane after the forward pulse has passed.
  const sourceYMm = pulseMm / 2 + 2 * b;
  const measureYMm = sourceYMm + 6 * b + b; // 6 b of evanescent decay, plus room for the grading near the source end
  // Far end: the echo off the far end (or the grading before it) must reach the plane after the forward pulse has passed it.
  const lengthMm = measureYMm + pulseMm / 2 + 4 * b;
  const top = (y0: number, y1: number, x0: number, x1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const boardOutline = top(0, lengthMm, -halfBoard, halfBoard);
  const spec: BoardSpec = {
    name,
    outline: boardOutline,
    stackup: [
      { type: 'copper', name: 'gnd' },
      { type: 'dielectric', name: 'lower', thicknessMm: b / 2, epsR },
      { type: 'copper', name: 'strip' },
      { type: 'dielectric', name: 'upper', thicknessMm: b / 2, epsR },
      { type: 'copper', name: 'top' },
    ],
    copper: {
      gnd: [boardOutline],
      strip: [top(0, lengthMm, stripCentreMm - widthMm / 2, stripCentreMm + widthMm / 2)],
      top: [boardOutline],
    },
    // Terminates the far end; never excited.
    ports: [{ id: 'far', at: [stripCentreMm, lengthMm], between: ['gnd', 'strip'] }],
    boundary: { xy: 'pec', y: 'pml', z: 'pec' },
    mesh: {
      cellMm: b / 3,
      edgeCellMm: widthMm / rng.uniform(4, 8),
      dielectricCells: rng.integer(0, 1) === 0 ? 2 : 4,
      maxGrowth: rng.uniform(1.2, 1.4),
      // Equal air below and above keeps the z mesh symmetric about the strip.
      margin: { xy: 1, below: 1, above: 1 },
    },
    band: { fMinGHz, fMaxGHz, nFreq: 9 },
    stop: { decayDb: 50, maxSteps: 1 },
  };
  return { spec, widthMm, groundSpacingMm: b, epsR, stripCentreMm, gapMm, sourceYMm, measureYMm };
}

interface LineReading {
  z0: number;
  /** Band mean of the signed relative error beta / beta_Yee - 1 (a cross-section L'C' error would show as a constant offset). */
  betaError: number;
  /** Largest |beta / beta_Yee - 1| over the band, for the report. */
  betaRipple: number;
  steps: number;
  /** Mesh lines, for the relabelling checks. */
  mesh: { x: Float64Array; y: Float64Array; z: Float64Array };
  hMm: number;
  /** Problems with the measurement itself (not the solver). */
  harness: string[];
  edgeCorrected: boolean;
}

const nearest = (lines: Float64Array, v: number) => {
  let best = 0;
  for (let n = 1; n < lines.length; n++) if (Math.abs(lines[n] - v) < Math.abs(lines[best] - v)) best = n;
  return best;
};

/** Solve one stripline board and read Z0 and beta from the forward wave. */
export function measureStripline(c: StriplineCase, spec: BoardSpec): LineReading {
  const { model } = rasterise(toProject(spec));
  const { mesh, grid } = model;
  const harness: string[] = [];
  const dt = timestepSec(grid);
  const dRef = grid.dxMm;
  const [nx, ny] = [grid.nx, grid.ny];
  const N = nx * ny * grid.nz;
  // The board may have been translated, mirrored or scaled: read positions off this spec.
  const stripXs = spec.copper.strip[0].map((p) => p[0]);
  const stripX = (Math.min(...stripXs) + Math.max(...stripXs)) / 2;
  const w = Math.max(...stripXs) - Math.min(...stripXs);
  const b = spec.stackup.reduce((sum, l) => sum + (l.thicknessMm ?? 0), 0);
  const s = b / c.groundSpacingMm;
  const yLo = Math.min(...spec.outline.map((p) => p[1]));
  const srcY = yLo + c.sourceYMm * s;
  const measY = yLo + c.measureYMm * s;

  const i0 = nearest(mesh.x, stripX);
  if (Math.abs(mesh.x[i0] - stripX) > 1e-6 * dRef) harness.push(`no mesh line at the strip centre (${stripX} mm)`);
  const jSrc = nearest(mesh.y, srcY);
  const j = nearest(mesh.y, measY);
  // The z planes of the three copper layers: z = 0, b/2, b.
  const kGnd = nearest(mesh.z, 0);
  const kStrip = nearest(mesh.z, b / 2);
  const kTop = nearest(mesh.z, b);
  // z mesh must be symmetric about the strip, or the symmetric source also launches the parallel-plate mode.
  for (let d = 1; d <= kTop - kStrip; d++) {
    const [up, down] = [mesh.z[kStrip + d] - mesh.z[kStrip], mesh.z[kStrip] - mesh.z[kStrip - d]];
    if (Math.abs(up - down) > 1e-9 * Math.max(1, up)) { harness.push(`z mesh not symmetric about the strip (${up} vs ${down} mm at ${d} lines)`); break; }
  }
  // The measurement plane must sit in uniform y cells (the 1D dispersion relation assumes them).
  const dy = cellWidth(mesh.y, j);
  for (let n = j - 2; n <= j + 2; n++) if (Math.abs(cellWidth(mesh.y, n) - dy) > 1e-9 * dy) harness.push(`y cells not uniform around the measurement plane (cell ${n})`);
  // Far reflector for the gate: the first non-uniform y cell past the plane (grading toward the far end).
  let jFar = j;
  while (jFar + 1 < ny && Math.abs(cellWidth(mesh.y, jFar) - dy) <= 1e-9 * dy) jFar++;
  const v = C0 / Math.sqrt(c.epsR);
  const exc = { fMinGHz: spec.band.fMinGHz, fMaxGHz: spec.band.fMaxGHz, nFreq: spec.band.nFreq, z0: 50 };
  const sp = sourceParams(exc);
  const forwardEndSec = ((mesh.y[j + 1] - mesh.y[jSrc]) * 1e-3) / v + sp.t0Sec + 3.72 * sp.tauSec;
  // Echoes: off the far end (or the grading before it), and off the near end behind the source.
  const echoSec = Math.min(2 * mesh.y[jFar] - mesh.y[jSrc] - mesh.y[j], mesh.y[jSrc] + mesh.y[j] - 2 * yLo) * 1e-3 / v;
  if (!(forwardEndSec < echoSec)) harness.push(`gate too short: forward pulse ends at ${forwardEndSec} s, echo at ${echoSec} s`);
  const steps = Math.floor(echoSec / dt);

  // Ampere loop: Ey edges i in [ia, ib], k in [kGnd + 1, kTop - 1]: strip plus b/2 of dielectric each side.
  const ia = nearest(mesh.x, stripX - w / 2 - b / 2);
  const ib = nearest(mesh.x, stripX + w / 2 + b / 2);
  const at = (i: number, jj: number, k: number) => i + nx * (jj + ny * k);
  const lineVoltage = (sim: CpuFdtd, jj: number) => {
    // V of the strip against the grounds: -sum Ez dz below the strip, +sum Ez dz above; averaged.
    let below = 0;
    let above = 0;
    for (let k = kGnd; k < kStrip; k++) below -= sim.e[2 * N + at(i0, jj, k)] * (cellWidth(mesh.z, k) / dRef);
    for (let k = kStrip; k < kTop; k++) above += sim.e[2 * N + at(i0, jj, k)] * (cellWidth(mesh.z, k) / dRef);
    return (below + above) / 2;
  };
  const loopCurrent = (sim: CpuFdtd) => {
    let s = 0;
    for (let i = ia; i <= ib; i++) s += (sim.h[at(i, j, kTop - 1)] - sim.h[at(i, j, kGnd)]) * (dualWidth(mesh.x, i) / dRef);
    for (let k = kGnd + 1; k <= kTop - 1; k++) s -= (sim.h[2 * N + at(ib, j, k)] - sim.h[2 * N + at(ia - 1, j, k)]) * (dualWidth(mesh.z, k) / dRef);
    return s / ETA0;
  };

  const sim = new CpuFdtd(model);
  const v0 = new Float64Array(steps);
  const v1 = new Float64Array(steps);
  const current = new Float64Array(steps);
  const below = Array.from({ length: kStrip - kGnd }, (_, n) => 2 * N + at(i0, jSrc, kGnd + n));
  const aboveCells = Array.from({ length: kTop - kStrip }, (_, n) => 2 * N + at(i0, jSrc, kStrip + n));
  for (let n = 0; n < steps; n++) {
    sim.updateH();
    sim.updateE();
    const drive = sourceValue(sp, (n + 0.5) * dt);
    for (const e of below) sim.e[e] -= drive;
    for (const e of aboveCells) sim.e[e] += drive;
    sim.updatePort(0, -1); // the far-end termination, passive
    v0[n] = lineVoltage(sim, j);
    v1[n] = lineVoltage(sim, j + 1);
    current[n] = loopCurrent(sim);
  }

  const frequencies = Array.from({ length: spec.band.nFreq }, (_, m) => (spec.band.fMinGHz + ((spec.band.fMaxGHz - spec.band.fMinGHz) * m) / (spec.band.nFreq - 1)) * 1e9);
  let zSum = 0;
  let betaSum = 0;
  let betaRipple = 0;
  for (const f of frequencies) {
    // E at (n + 1) dt, H at (n + 1/2) dt.
    const [a0, a1, ci] = [dft(v0, dt, f, 1), dft(v1, dt, f, 1), dft(current, dt, f, 0.5)];
    const ph0 = Math.atan2(a0[1], a0[0]);
    // The wave lags by beta dy in (0, 2 pi) from node j to j + 1.
    const lag = (((ph0 - Math.atan2(a1[1], a1[0])) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const ph1 = ph0 - lag;
    // V at the loop's plane (midway): geometric mean of the two nodes.
    const vMag = Math.sqrt(Math.hypot(...a0) * Math.hypot(...a1));
    const vPhase = (ph0 + ph1) / 2;
    const iMag = Math.hypot(...ci);
    const iPhase = Math.atan2(ci[1], ci[0]);
    zSum += (vMag / iMag) * Math.cos(vPhase - iPhase);
    const beta = lag / (dy * 1e-3);
    const relative = beta / yeeTemBeta(f, dy * 1e-3, dt, c.epsR) - 1;
    betaSum += relative;
    betaRipple = Math.max(betaRipple, Math.abs(relative));
  }
  // Whether rasterise moved the strip's edge lines into the copper (the sheet-edge offset): no line on the drawn edges.
  const drawn = [stripX - w / 2, stripX + w / 2];
  const edgeCorrected = drawn.every((x) => Math.abs(mesh.x[nearest(mesh.x, x)] - x) > 1e-6 * dRef);
  return { z0: Math.abs(zSum / frequencies.length), betaError: betaSum / frequencies.length, betaRipple, steps, mesh, hMm: spec.mesh.edgeCellMm, harness, edgeCorrected };
}

export function runStripline(rng: Rng, tier: 'quick' | 'full'): Check[] {
  const cases = tier === 'quick' ? 1 : 3;
  // Finest ratio at least 1.5, so the Richardson check can see a first-order term (docs/self-verify.md).
  const levels = tier === 'quick' ? [1, 2, 3] : [1, 1.5, 2, 3];
  const checks: Check[] = [];
  for (let n = 0; n < cases; n++) {
    const caseRng = rng.fork(`case${n}`);
    const c = drawStripline(caseRng, `stripline-${n}`);
    const label = `W ${c.widthMm.toFixed(3)} mm, b ${c.groundSpacingMm.toFixed(3)} mm, eps_r ${c.epsR.toFixed(3)}, edge cell ${c.spec.mesh.edgeCellMm.toFixed(4)} mm, ${c.spec.mesh.dielectricCells} cells per half`;
    const exact = cohnStriplineZ0(c.widthMm, c.groundSpacingMm, c.epsR);
    const floor = exact * (striplineWidthModelError(c.gapMm, c.groundSpacingMm) + TEM_EXTRACTION_ERROR);
    const readings = levels.map((m) => measureStripline(c, refine(c.spec, m)));
    const harness = [...new Set(readings.flatMap((r) => r.harness))];
    const corrected = readings.map((r) => (r.edgeCorrected ? 'moved' : 'on the drawn edge'));
    const base = { family: FAMILY, case: `${c.spec.name}: ${label}` };
    if (harness.length > 0) {
      checks.push({ ...base, check: 'measurement set-up', verdict: 'inconclusive', measured: null, expected: null, tolerance: null, note: harness.join('; ') });
      continue;
    }
    const studied: Level[] = readings.map((r) => ({ hMm: r.hMm, value: r.z0 }));
    const values = studied.map((l) => `${l.value.toFixed(4)}`).join(' / ');
    // beta against the 1D Yee dispersion of the line's own y cells: exact for the TEM mode of a uniform fill.
    readings.forEach((r, k) => {
      checks.push(compare({
        ...base, check: `beta vs 1D Yee dispersion, level ${levels[k]}`, measured: r.betaError, expected: 0, tolerance: TEM_EXTRACTION_ERROR + roundoffError(r.steps),
        note: `band-mean signed relative error (largest at one frequency ${r.betaRipple.toExponential(2)}); exact discrete truth`,
      }));
    });
    const order = observedOrderAgainstExact(studied, exact, floor);
    checks.push({
      ...base, check: 'observed order of the Z0 error', verdict: orderVerdict(order.order), measured: order.order, expected: 2, tolerance: null,
      note: `needs ${MIN_OBSERVED_ORDER} to ${MAX_OBSERVED_ORDER}; ${order.reason}; Z0 by level ${values} ohm vs Cohn ${exact.toFixed(4)} ohm; strip edge lines ${corrected.join(', ')}`,
    });
    const { extrapolated, band } = richardson(studied);
    checks.push(compare({
      ...base, check: 'Z0 extrapolated vs Cohn (exact)', measured: extrapolated, expected: exact, tolerance: band + floor,
      note: `Richardson at order 2 from the two finest levels; band = GCI (Fs 1.25) + Cohn's wall error + extraction error`,
    }));

    // Invariances at the coarsest level: the same discrete problem relabelled, so roundoff only.
    const coarse = readings[0];
    const relabelled = (name: string, transformed: BoardSpec, maps: (r: LineReading) => boolean, expected: number) => {
      const r = measureStripline(c, transformed);
      if (r.harness.length > 0) {
        checks.push({ ...base, check: name, verdict: 'inconclusive', measured: null, expected: null, tolerance: null, note: r.harness.join('; ') });
        return;
      }
      if (!maps(r)) {
        // Mirror, translation and scaling with the mesh must reproduce the mesh; when they do not, the mesher is at fault.
        checks.push({ ...base, check: name, verdict: 'fail', measured: r.z0, expected, tolerance: null, note: 'the transformed mesh does not map onto the original (mesher not equivariant)' });
        return;
      }
      checks.push(compare({
        ...base, check: name, measured: r.z0, expected, tolerance: expected * (roundoffError(r.steps) + TEM_EXTRACTION_ERROR),
        note: 'mesh maps onto the original: same discrete problem, roundoff only',
      }));
    };
    const shift: [number, number] = [caseRng.uniform(0.05, 0.95) * c.spec.mesh.edgeCellMm, caseRng.uniform(0.05, 0.95) * c.spec.mesh.edgeCellMm];
    relabelled('Z0 under a sub-cell translation', translate(c.spec, shift), (r) => linesMap(coarse.mesh.x, r.mesh.x, 1, shift[0], 1) && linesMap(coarse.mesh.y, r.mesh.y, 1, shift[1], 1), coarse.z0);
    relabelled('Z0 under a mirror in x', mirrorX(c.spec), (r) => linesMap(coarse.mesh.x, r.mesh.x, 1, 0, -1) && linesMap(coarse.mesh.y, r.mesh.y, 1, 0, 1), coarse.z0);
    const s = caseRng.uniform(0.6, 1.6);
    relabelled('Z0 under scaling with the mesh', scale(c.spec, s, true), (r) => linesMap(coarse.mesh.x, r.mesh.x, s, 0, 1) && linesMap(coarse.mesh.y, r.mesh.y, s, 0, 1) && linesMap(coarse.mesh.z, r.mesh.z, s, 0, 1), coarse.z0);

  }
  return checks;
}
