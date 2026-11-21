/**
 * Lumped components (R, L, C, series or parallel RLC) against circuit theory,
 * on the 1 mm FR-4 line of tests/project_fixtures.ts (1 mm cells, CPU).
 *
 *   1. Terminal check: measure the line's two-port S, then put a component on
 *      port 2's cell. Network theory predicts S11 from S and the part's Z.
 *   2. A series part across a 2 mm gap in the strip, de-embedded with a
 *      2x-thru (the same line without the gap), read back as Z.
 *   3. A shunt series LC to ground: the notch in S21 against 1 / (2 pi sqrt(LC)).
 *   4. An L-section match, 50 ohm to a 100 ohm load at 2.4 GHz, against the
 *      network prediction from the board's measured two-port S.
 *
 *   npx tsx scripts/validate/lumped_components.ts   -> docs/validation/data/lumped_components.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { CpuFdtd } from '../../src/engine/fdtd_cpu';
import { componentImpedance, type ComponentValues } from '../../src/engine/lumped';
import { divide, multiply, scatteringMatrix, type Complex, type ScatteringResult } from '../../src/engine/port_dft';
import { rasterise } from '../../src/project/rasterise';
import { resolveProject } from '../../src/project/resolve';
import { parseProject } from '../../src/project/schema';
import { rect, twoPortLineJson } from '../../tests/project_fixtures';

const OUT = new URL('../../docs/validation/data/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const add = (x: Complex, y: Complex): Complex => [x[0] + y[0], x[1] + y[1]];
const sub = (x: Complex, y: Complex): Complex => [x[0] - y[0], x[1] - y[1]];
const neg = (x: Complex): Complex => [-x[0], -x[1]];
const ONE: Complex = [1, 0];
const db = (x: Complex) => 20 * Math.log10(Math.hypot(x[0], x[1]));
const csqrt = ([re, im]: Complex): Complex => {
  const r = Math.hypot(re, im);
  return [Math.sqrt((r + re) / 2), (im < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (r - re) / 2))];
};
const round = (x: number, digits = 4) => Number(x.toPrecision(digits));

/** The fixture line without its stub, lossless FR-4, run to a 60 dB energy decay. */
function lineJson(band: { fMinGHz: number; fMaxGHz: number; nFreq: number }): Record<string, any> {
  const json = twoPortLineJson();
  json.geometry.top = [json.geometry.top[0]];
  json.materials = { lossless: { eps_r: 4.4, tan_delta: 0 } };
  json.stackup[1].material = 'lossless';
  json.analysis = { ...json.analysis, f_min_ghz: band.fMinGHz, f_max_ghz: band.fMaxGHz, n_freq: band.nFreq, stop: { energy_decay_db: 60, max_steps: 40_000 } };
  json.outputs = { zin_at_ghz: [band.fMinGHz] };
  return json;
}

/** Strip with a gap from y = -1 mm to 1 mm. */
const GAPPED_STRIP = [
  { id: 'a', op: 'add', polygon: rect('-1 mm', '-half_len', '1 mm', '-1 mm') },
  { id: 'b', op: 'add', polygon: rect('-1 mm', '1 mm', '1 mm', 'half_len') },
];

function solve(json: Record<string, any>): ScatteringResult {
  const project = parseProject(json);
  const a = project.analysis;
  const exc = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 };
  const control = { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: 100 };
  const solver = new CpuFdtd(rasterise(project).model);
  const runs = project.ports.map((_, p) => ({ activePort: p, samples: solver.run(exc, control, undefined, p) }));
  return scatteringMatrix(runs, project.ports.map(() => 50), exc);
}

const entry = (S: ScatteringResult, i: number, j: number, k: number): Complex => [S.re[i][j]![k], S.im[i][j]![k]];
const omega = (fGHz: number) => 2 * Math.PI * fGHz * 1e9;
const seconds = (t0: number) => round((performance.now() - t0) / 1000, 3);

/* ------------------------------------------------ 1. terminal check */

const CELL_CAPACITANCE_F = 8.8541878128e-12 * 4.4 * 1e-3; // eps0 eps_r A / l of the 1 mm port cell

/**
 * S11 at port 1 when a part replaces port 2, from the two-port S measured with
 * both ports: S11 + S12 S21 GL / (1 - S22 GL), GL from the part's Z in parallel
 * with the capacitance of the port's own cell (the port's current is the H
 * loop around the cell, so that capacitance is inside the port).
 */
function predictedS11(twoPort: ScatteringResult, k: number, values: ComponentValues): Complex {
  const fGHz = twoPort.fGHz[k];
  const terminal = divide(ONE, add(divide(ONE, componentImpedance(values, fGHz * 1e9)), [0, omega(fGHz) * CELL_CAPACITANCE_F]));
  const gl = divide(sub(terminal, [50, 0]), add(terminal, [50, 0]));
  return add(entry(twoPort, 0, 0, k), divide(multiply(multiply(entry(twoPort, 0, 1, k), entry(twoPort, 1, 0, k)), gl), sub(ONE, multiply(entry(twoPort, 1, 1, k), gl))));
}

/** `json` with port 2 replaced by `part` on the same cell; its solve and the part's values. */
function loadPort2(json: Record<string, any>, part: Record<string, unknown>) {
  json.ports = [json.ports[0]];
  json.components = [...(json.components ?? []), { id: 'load', x: '0 mm', y: 'half_len', between: ['top', 'gnd'], ...part }];
  const values = resolveProject(parseProject(json)).components.find((c) => c.id === 'load')!.values;
  return { S: solve(json), values };
}

function terminalCheck() {
  const band = { fMinGHz: 1, fMaxGHz: 10, nFreq: 19 };
  const twoPort = solve(lineJson(band));
  const parts = [
    { r_ohm: 20, l_nh: 3, c_pf: 1, connection: 'series' },
    { r_ohm: 200, l_nh: 2, c_pf: 0.5, connection: 'parallel' },
    { l_nh: 1 },
    { c_pf: 2 },
  ];
  return parts.map((part) => {
    const { S, values } = loadPort2(lineJson(band), part);
    let worst = 0;
    for (let k = 0; k < twoPort.fGHz.length; k++) worst = Math.max(worst, Math.hypot(...sub(entry(S, 0, 0, k), predictedS11(twoPort, k, values))));
    console.log(`terminal ${JSON.stringify(part)}: worst |dS11| ${worst.toExponential(2)} over 1-10 GHz`);
    return { part, worstAbsDeltaS11: round(worst, 3) };
  });
}

/* ------------------------------------------------ 2. series part in a gap, 2x-thru de-embedded */

type Abcd = [Complex, Complex, Complex, Complex];

function abcdFromS(S: ScatteringResult, k: number, z0 = 50): Abcd {
  const [s11, s12, s21, s22] = [entry(S, 0, 0, k), entry(S, 0, 1, k), entry(S, 1, 0, k), entry(S, 1, 1, k)];
  const d = multiply([2, 0], s21);
  const s12s21 = multiply(s12, s21);
  return [
    divide(add(multiply(add(ONE, s11), sub(ONE, s22)), s12s21), d),
    multiply([z0, 0], divide(sub(multiply(add(ONE, s11), add(ONE, s22)), s12s21), d)),
    divide(divide(sub(multiply(sub(ONE, s11), sub(ONE, s22)), s12s21), d), [z0, 0]),
    divide(add(multiply(sub(ONE, s11), add(ONE, s22)), s12s21), d),
  ];
}

const abcdProduct = (x: Abcd, y: Abcd): Abcd => [
  add(multiply(x[0], y[0]), multiply(x[1], y[2])), add(multiply(x[0], y[1]), multiply(x[1], y[3])),
  add(multiply(x[2], y[0]), multiply(x[3], y[2])), add(multiply(x[2], y[1]), multiply(x[3], y[3])),
];

/**
 * The thru is two identical symmetric halves H with T = H H. For a symmetric
 * reciprocal half, A = D and AD - BC = 1, so the half is A_h = sqrt((A + 1) / 2),
 * B_h = B / (2 A_h), C_h = C / (2 A_h), and its inverse swaps the signs of B_h, C_h.
 */
function halfThruInverse(thru: Abcd): Abcd {
  const a = csqrt(divide(add(thru[0], ONE), [2, 0]));
  const twoA = multiply([2, 0], a);
  return [a, neg(divide(thru[1], twoA)), neg(divide(thru[2], twoA)), a];
}

function gapSeries() {
  const band = { fMinGHz: 0.5, fMaxGHz: 3, nFreq: 6 };
  const thruJson = lineJson(band);
  const thru = solve(thruJson);
  const parts = [{ r_ohm: 50 }, { r_ohm: 10 }, { l_nh: 2 }, { c_pf: 1 }];
  return parts.map((part) => {
    const json = lineJson(band);
    json.geometry.top = GAPPED_STRIP;
    json.components = [{ id: 'X', layer: 'top', from: ['0 mm', '-1 mm'], to: ['0 mm', '1 mm'], width: '2 mm', ...part }];
    const values = resolveProject(parseProject(json)).components[0].values;
    const S = solve(json);
    const rows = Array.from(S.fGHz, (fGHz, k) => {
      const hInv = halfThruInverse(abcdFromS(thru, k));
      const dut = abcdProduct(abcdProduct(hInv, abcdFromS(S, k)), hInv);
      const z = dut[1];
      const ideal = componentImpedance(values, fGHz * 1e9);
      return { fGHz: round(fGHz), zRe: round(z[0]), zIm: round(z[1]), idealRe: round(ideal[0]), idealIm: round(ideal[1]) };
    });
    console.log(`gap ${JSON.stringify(part)}: ` + rows.map((r) => `${r.fGHz} GHz ${r.zRe}${r.zIm < 0 ? '-' : '+'}j${Math.abs(r.zIm)}`).join(', '));
    return { part, rows };
  });
}

/* ------------------------------------------------ 3. shunt series LC notch */

function lcNotch() {
  const lNh = 3, cPf = 0.5;
  const idealGHz = 1 / (2 * Math.PI * Math.sqrt(lNh * 1e-9 * cPf * 1e-12)) / 1e9;
  const json = lineJson({ fMinGHz: 2.5, fMaxGHz: 5.5, nFreq: 121 });
  json.components = [{ id: 'LC', x: '0 mm', y: '0 mm', between: ['top', 'gnd'], l_nh: lNh, c_pf: cPf, connection: 'series' }];
  const S = solve(json);
  const s21 = S.fGHz.map((_, k) => db(entry(S, 1, 0, k)));
  const k = s21.indexOf(Math.min(...s21));
  // Parabolic refinement of the minimum.
  const [y0, y1, y2] = [s21[k - 1], s21[k], s21[k + 1]];
  const step = S.fGHz[1] - S.fGHz[0];
  const notchGHz = S.fGHz[k] + (step * (y0 - y2)) / (2 * (y0 - 2 * y1 + y2));
  // Inductance in series with the part that moves the notch there: the 1 mm post through the substrate.
  const extraNh = 1 / (omega(notchGHz) ** 2 * cPf * 1e-12) * 1e9 - lNh;
  console.log(`LC notch: ${notchGHz.toFixed(3)} GHz (ideal ${idealGHz.toFixed(3)}), depth ${y1.toFixed(1)} dB, implied post inductance ${extraNh.toFixed(3)} nH`);
  return { lNh, cPf, idealGHz: round(idealGHz), notchGHz: round(notchGHz), depthDb: round(y1, 3), impliedPostInductanceNh: round(extraNh, 3) };
}

/* ------------------------------------------------ 4. L-section match */

/**
 * 100 ohm load at the y_max end of the line (port 2's cell), 50 ohm source.
 * Shunt C across the load: Re{1 / (1/100 + j w C)} = 50 gives w C = 0.01 S,
 * leaving 50 - j50; a series L of 50 ohm cancels it. The L sits in a 2 mm gap
 * 2 mm from the load. The line's own lumped ports are not 50 ohm on 1 mm
 * cells (boardWithPortsS11Db: the bare line reflects about -13 dB at 2.4 GHz),
 * so each case is also predicted from the two-port S of the same board
 * measured with both ports. That board includes the series L, so the
 * prediction tests the load part on it; the L alone is case 2's job.
 */
function lSectionMatch() {
  const fGHz = 2.4, w = omega(fGHz);
  const cPf = 0.01 / w * 1e12, lNh = 50 / w * 1e9;
  const band = { fMinGHz: 1, fMaxGHz: 4, nFreq: 61 };
  const board = (match: boolean) => {
    const json = lineJson(band);
    if (match) {
      json.geometry.top = [
        { id: 'a', op: 'add', polygon: rect('-1 mm', '-half_len', '1 mm', 'half_len - 4 mm') },
        { id: 'b', op: 'add', polygon: rect('-1 mm', 'half_len - 2 mm', '1 mm', 'half_len') },
      ];
      json.components = [{ id: 'Lm', layer: 'top', from: ['0 mm', 'half_len - 4 mm'], to: ['0 mm', 'half_len - 2 mm'], width: '2 mm', l_nh: lNh }];
    }
    return json;
  };
  const sweep = (match: boolean) => {
    const twoPort = solve(board(match));
    const { S, values } = loadPort2(board(match), { r_ohm: 100, ...(match ? { c_pf: cPf, connection: 'parallel' } : {}) });
    return Array.from(S.fGHz, (f, k) => ({ fGHz: round(f), s11Db: round(db(entry(S, 0, 0, k)), 4), predictedDb: round(db(predictedS11(twoPort, k, values)), 4), boardWithPortsS11Db: round(db(entry(twoPort, 0, 0, k)), 4) }));
  };
  const unmatched = sweep(false), matched = sweep(true);
  const at = (rows: typeof unmatched) => rows.reduce((best, r) => (Math.abs(r.fGHz - fGHz) < Math.abs(best.fGHz - fGHz) ? r : best));
  const best = matched.reduce((m, r) => (r.s11Db < m.s11Db ? r : m));
  const [u, m] = [at(unmatched), at(matched)];
  console.log(`L-section at ${fGHz} GHz: bare line with both ports ${u.boardWithPortsS11Db.toFixed(1)} dB; unmatched ${u.s11Db.toFixed(1)} dB (predicted ${u.predictedDb.toFixed(1)}, ideal circuit ${db([1 / 3, 0]).toFixed(1)}), matched ${m.s11Db.toFixed(1)} dB (predicted ${m.predictedDb.toFixed(1)}); deepest ${best.s11Db.toFixed(1)} dB at ${best.fGHz} GHz`);
  return { fGHz, lNh: round(lNh), cPf: round(cPf), unmatchedAtF: u, matchedAtF: m, deepestMatched: best, unmatched, matched };
}

const t0 = performance.now();
const result = { terminal: terminalCheck(), gap: gapSeries(), notch: lcNotch(), lSection: lSectionMatch(), runSeconds: 0 };
result.runSeconds = seconds(t0);
writeFileSync(new URL('lumped_components.json', OUT), JSON.stringify(result, null, 1));
console.log(`done in ${result.runSeconds} s`);
