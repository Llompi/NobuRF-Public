import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  abcdMultiply, abcdToS, deembedPorts, expectedPhaseDeg, flip, lineAbcd, lowFrequencyLineImpedance, LINE_PHASE_MARGIN_DEG, sToAbcd, thruLineErrorBoxes, type Abcd, type TwoPortS,
} from '../src/engine/deembed';
import type { Complex, ScatteringResult } from '../src/engine/port_dft';
import { kitBand, kitProject, lineStandardsMm, MAX_EXTRA_LINE_MM, readFeed } from '../src/project/deembed_kit';
import { resolveProject } from '../src/project/resolve';
import { idx3 } from '../src/engine/voxelize';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';

const Z0 = 50;
const C_MM_PER_NS = 299.792458;

/** A port that is not symmetric: series L, shunt C, then a feed line. Reciprocal, so det = 1. */
function portBox(fGHz: number, feedMm: number, zLine: number, epsEff: number): Abcd {
  const w = 2 * Math.PI * fGHz; // rad/ns: L in nH, C in nF
  const series: Abcd = { a: [1, 0], b: [0, w * 0.4], c: [0, 0], d: [1, 0] };
  const shunt: Abcd = { a: [1, 0], b: [0, 0], c: [0, w * 0.0003], d: [1, 0] };
  return abcdMultiply(abcdMultiply(series, shunt), line(fGHz, feedMm, zLine, epsEff));
}

function line(fGHz: number, lengthMm: number, z: number, epsEff: number, lossNpPerMm = 0): Abcd {
  const beta = (2 * Math.PI * fGHz * Math.sqrt(epsEff)) / C_MM_PER_NS;
  return lineAbcd([lossNpPerMm, beta], lengthMm, [z, 0]);
}

function twoPortResult(fGHz: number[], s: TwoPortS[]): ScatteringResult {
  const n = fGHz.length;
  const grid = () => [[new Float64Array(n), new Float64Array(n)], [new Float64Array(n), new Float64Array(n)]];
  const re = grid();
  const im = grid();
  s.forEach((x, m) => {
    ([[0, 0, x.s11], [0, 1, x.s12], [1, 0, x.s21], [1, 1, x.s22]] as Array<[number, number, Complex]>).forEach(([i, j, v]) => {
      re[i][j][m] = v[0];
      im[i][j][m] = v[1];
    });
  });
  return { fGHz: Float64Array.from(fGHz), re, im, method: 'full', maxPassiveIncidentRatio: 0 };
}

const close = (a: Complex, b: Complex, tol: number) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(tol);

describe('de-embedding network arithmetic', () => {
  const f = Array.from({ length: 60 }, (_, m) => 0.2 + m * 0.1);
  const zLine = 48.7;
  const epsEff = 2.7;
  const feedMm = 10;

  it('S and ABCD convert both ways', () => {
    const s: TwoPortS = { s11: [0.1, -0.2], s12: [0.7, 0.3], s21: [0.7, 0.3], s22: [-0.05, 0.15] };
    const back = abcdToS(sToAbcd(s, Z0), Z0);
    close(back.s11, s.s11, 1e-12);
    close(back.s21, s.s21, 1e-12);
    close(back.s22, s.s22, 1e-12);
  });

  it('thru-line calibration recovers an asymmetric port box and the line, and de-embedding recovers the circuit', () => {
    const boxes = f.map((x) => portBox(x, feedMm, zLine, epsEff));
    const thru = boxes.map((a) => abcdToS(abcdMultiply(a, flip(a)), Z0));
    const extras = lineStandardsMm(f[0], f[f.length - 1], epsEff);
    const lines = extras.map((extraMm) => ({ extraMm, s: f.map((x, m) => abcdToS(abcdMultiply(abcdMultiply(boxes[m], line(x, extraMm, zLine, epsEff)), flip(boxes[m])), Z0)) }));
    const kit = thruLineErrorBoxes(f, thru, lines, epsEff * 1.04, zLine, Z0);
    expect(kit.lineUsed.every((x) => x !== null)).toBe(true);
    kit.box.forEach((b, m) => {
      close(b.a, boxes[m].a, 1e-9);
      close(b.b, boxes[m].b, 1e-7);
      close(b.c, boxes[m].c, 1e-9);
      close(b.d, boxes[m].d, 1e-9);
      const beta = (2 * Math.PI * f[m] * Math.sqrt(epsEff)) / C_MM_PER_NS;
      close(kit.gammaPerMm[m]!, [0, beta], 1e-9);
    });
    // A circuit between the two feeds: a 22 ohm section, 9 mm, with some loss.
    const dut = f.map((x) => line(x, 9, 22, 3.0, 1e-3));
    const measured = twoPortResult(f, f.map((_, m) => abcdToS(abcdMultiply(abcdMultiply(boxes[m], dut[m]), flip(boxes[m])), Z0)));
    const out = deembedPorts(measured, [kit.box, kit.box], [Z0, Z0]);
    f.forEach((_, m) => {
      const want = abcdToS(dut[m], Z0);
      close([out.re[0][0]![m], out.im[0][0]![m]], want.s11, 1e-9);
      close([out.re[1][0]![m], out.im[1][0]![m]], want.s21, 1e-9);
      close([out.re[0][1]![m], out.im[0][1]![m]], want.s12, 1e-9);
      close([out.re[1][1]![m], out.im[1][1]![m]], want.s22, 1e-9);
    });
  });

  it('the line impedance comes from the low-frequency limit, where the port vanishes', () => {
    const boxes = f.map((x) => portBox(x, feedMm, zLine, epsEff));
    const thru = boxes.map((a) => abcdToS(abcdMultiply(a, flip(a)), Z0));
    const long = f.map((x, m) => abcdToS(abcdMultiply(abcdMultiply(boxes[m], line(x, 50, zLine, epsEff)), flip(boxes[m])), Z0));
    const fit = lowFrequencyLineImpedance(f, thru, long, Z0, 1.3);
    expect(fit.points).toBe(12);
    expect(Math.abs(fit.zOhm - zLine) / zLine).toBeLessThan(0.005);
  });

  it('falls back to the symmetric half where no line has a usable phase, and says where', () => {
    const boxes = f.map((x) => portBox(x, feedMm, zLine, epsEff));
    const thru = boxes.map((a) => abcdToS(abcdMultiply(a, flip(a)), Z0));
    const lines = [{ extraMm: 5, s: f.map((x, m) => abcdToS(abcdMultiply(abcdMultiply(boxes[m], line(x, 5, zLine, epsEff)), flip(boxes[m])), Z0)) }];
    const kit = thruLineErrorBoxes(f, thru, lines, epsEff, zLine, Z0);
    f.forEach((x, m) => {
      const deg = expectedPhaseDeg(x, epsEff, 5) % 180;
      expect(kit.lineUsed[m] === null).toBe(deg < LINE_PHASE_MARGIN_DEG || deg > 180 - LINE_PHASE_MARGIN_DEG);
    });
  });

  it('picks the line by its measured phase, so a 3 % eps_eff guess cannot choose a line that is near 0 or 180 degrees in fact', () => {
    const boxes = f.map((x) => portBox(x, feedMm, zLine, epsEff));
    const thru = boxes.map((a) => abcdToS(abcdMultiply(a, flip(a)), Z0));
    // The kit's own line set, designed and guessed 3 % low.
    const guess = epsEff * 0.97;
    const lines = lineStandardsMm(f[0], f[f.length - 1], guess).map((extraMm) => ({ extraMm, s: f.map((x, m) => abcdToS(abcdMultiply(abcdMultiply(boxes[m], line(x, extraMm, zLine, epsEff)), flip(boxes[m])), Z0)) }));
    const kit = thruLineErrorBoxes(f, thru, lines, guess, zLine, Z0);
    const distance = (x: number, n: number, eps: number) => Math.abs((expectedPhaseDeg(x, eps, lines[n].extraMm) % 180) - 90);
    const nearest = (x: number, eps: number) => lines.reduce((best, _, n) => (distance(x, n, eps) < distance(x, best, eps) ? n : best), 0);
    // The guess alone picks another line than the truth somewhere in the band.
    expect(f.some((x) => nearest(x, guess) !== nearest(x, epsEff))).toBe(true);
    f.forEach((x, m) => {
      expect(kit.lineUsed[m]).toBe(distance(x, nearest(x, epsEff), epsEff) > 90 - LINE_PHASE_MARGIN_DEG ? null : nearest(x, epsEff));
      close(kit.box[m].b, boxes[m].b, 1e-7);
      close(kit.box[m].c, boxes[m].c, 1e-9);
    });
  });

  it('a port without an error box passes through unchanged', () => {
    const s = twoPortResult([1], [{ s11: [0.2, 0.1], s12: [0.5, -0.4], s21: [0.5, -0.4], s22: [0.1, 0] }]);
    const out = deembedPorts(s, [null, null], [Z0, Z0]);
    expect(out.re[1][0]![0]).toBeCloseTo(0.5, 12);
    expect(out.im[0][0]![0]).toBeCloseTo(0.1, 12);
  });
});

describe('line standards and the calibration band', () => {
  it('every frequency of the band has a line standard between 25 and 155 degrees', () => {
    for (const [lo, hi, ee] of [[0.25, 6.5, 2.7], [1, 40, 6.5], [2, 3, 1.9], [0.5, 120, 3.3]]) {
      const extras = lineStandardsMm(lo, hi, ee);
      for (let k = 0; k <= 200; k++) {
        const f = lo * (hi / lo) ** (k / 200);
        const best = Math.min(...extras.map((x) => Math.abs((expectedPhaseDeg(f, ee, x) % 180) - 90)));
        expect(best).toBeLessThanOrEqual(65 + 1e-9);
      }
    }
  });

  it('caps the longest line, so the lowest frequencies fall outside it', () => {
    expect(lineStandardsMm(0.01, 1, 4)[0]).toBe(MAX_EXTRA_LINE_MM);
  });

  it('contains the project band and starts electrically short', () => {
    const analysis = { f_min_ghz: 2, f_max_ghz: 12, n_freq: 21, loss_reference_ghz: 5, stop: { energy_decay_db: 50, max_steps: 1000 } };
    const band = kitBand(analysis, 10, 4.4);
    const h = (band.fMaxGHz - band.fMinGHz) / (band.nFreq - 1);
    for (let m = 0; m < analysis.n_freq; m++) {
      expect(band.fMinGHz + (band.below + m * band.stride) * h).toBeCloseTo(2 + m * 0.5, 9);
    }
    const shortGHz = (C_MM_PER_NS / 12) / (10 * Math.sqrt(4.4));
    expect(band.fMinGHz).toBeGreaterThan(0);
    const low = Array.from({ length: band.nFreq }, (_, k) => band.fMinGHz + k * h).filter((x) => x <= shortGHz);
    expect(low.length).toBeGreaterThanOrEqual(6);
  });
});

const quarterWave = () => JSON.parse(readFileSync(new URL('../examples/textbook/pozar-ex5.5-quarter-wave.json', import.meta.url), 'utf8'));

function withDeembed(json: any, lengths: Array<string | null>) {
  json.ports.forEach((p: any, n: number) => {
    if (lengths[n]) p.deembed = { length: lengths[n] };
  });
  return json;
}

describe('reading a feed from the project', () => {
  it('finds both feeds of the quarter-wave transformer: direction, width and layers', () => {
    const r = resolveProject(parseProject(withDeembed(quarterWave(), ['10 mm', '10 mm'])));
    const a = readFeed(r, 0);
    const b = readFeed(r, 1);
    expect([a.direction, a.signalLayer, a.referenceLayer]).toEqual(['+x', 'top', 'gnd']);
    expect(a.edgesMm).toEqual([-0.9093, 0.9093]);
    expect(a.overhangMm).toBe(0);
    expect(b.direction).toBe('-x');
    expect(b.edgesMm).toEqual([-2.7838, 2.7838]);
  });

  it('builds a kit that is a valid project, with the feed doubled and port 2 at its end', () => {
    const project = parseProject(withDeembed(quarterWave(), ['10 mm', null]));
    const feed = readFeed(resolveProject(project), 0);
    const kit = parseProject(JSON.parse(JSON.stringify(kitProject(project, feed, 12, kitBand(project.analysis, 10, 3.55), 'thru'))));
    expect(kit.ports.map((p) => [p.kind ?? 'lumped', 'x' in p ? p.x : null])).toEqual([['lumped', '0 mm'], ['lumped', '32 mm']]);
    expect(kit.geometry.top[0].polygon[1]).toEqual(['32 mm', '-0.9093 mm']);
    expect(kit.geometry.gnd).toHaveLength(1);
    expect(kit.mesh).toEqual(project.mesh);
  });

  it('refuses a feed that changes width within the length', () => {
    const r = resolveProject(parseProject(withDeembed(quarterWave(), ['12 mm', null])));
    expect(() => readFeed(r, 0)).toThrow(/changes width/);
  });

  it('refuses copper beside the feed on its layer (coplanar ground)', () => {
    const json = withDeembed(quarterWave(), ['10 mm', null]);
    json.geometry.top.push({ id: 'cpw', op: 'add', polygon: [['-17 mm', '1.5 mm'], ['-8 mm', '1.5 mm'], ['-8 mm', '4 mm'], ['-17 mm', '4 mm']] });
    expect(() => readFeed(resolveProject(parseProject(json)), 0)).toThrow(/coplanar/);
  });

  it('refuses a component on the feed', () => {
    const json = withDeembed(quarterWave(), ['10 mm', null]);
    json.components = [{ id: 'r1', x: '-12 mm', y: '0 mm', between: ['gnd', 'top'], r_ohm: 100 }];
    expect(() => readFeed(resolveProject(parseProject(json)), 0)).toThrow(/component "r1" sits on the feed/);
  });

  it('refuses a via on the feed', () => {
    const json = withDeembed(quarterWave(), ['10 mm', null]);
    json.vias = [{ id: 'v1', x: '-12 mm', y: '0 mm', drill: '0.3 mm', between: ['gnd', 'top'] }];
    expect(() => readFeed(resolveProject(parseProject(json)), 0)).toThrow(/via "v1" sits on or beside the feed/);
  });

  it('refuses a port in the middle of a line, where the feed direction is ambiguous', () => {
    const json = withDeembed(quarterWave(), ['10 mm', null]);
    json.geometry.top[0].polygon = [['-30 mm', '-0.9093 mm'], ['-7.1601 mm', '-0.9093 mm'], ['-7.1601 mm', '0.9093 mm'], ['-30 mm', '0.9093 mm']];
    json.board.outline = [['-40 mm', '-8.7838 mm'], ['19.1601 mm', '-8.7838 mm'], ['19.1601 mm', '8.7838 mm'], ['-40 mm', '8.7838 mm']];
    json.geometry.gnd[0].polygon = json.board.outline;
    json.ports[0].x = '-18.58 mm';
    expect(() => readFeed(resolveProject(parseProject(json)), 0)).toThrow(/no straight feed .* other copper on "top"/);
  });

  it('accepts deembed on lumped ports only, with a positive length', () => {
    const json = quarterWave();
    json.ports[0].deembed = { length: '-1 mm' };
    expect(() => resolveProject(parseProject(json))).toThrow(/deembed.length: must be positive/);
    json.ports[0].deembed = { length: '1 mm', extra: 1 };
    expect(() => parseProject(json)).toThrow(/extra/);
  });
});

describe('agreement with the textbook exam calibration', () => {
  const read = (name: string) => {
    const rows = readFileSync(new URL(`./fixtures/exam-kits/${name}.s2p`, import.meta.url), 'utf8').split('\n')
      .filter((l) => l.trim() && !l.startsWith('!') && !l.startsWith('#')).map((l) => l.trim().split(/\s+/).map(Number));
    return { f: rows.map((r) => r[0]), s: rows.map((r): TwoPortS => ({ s11: [r[1], r[2]], s21: [r[3], r[4]], s12: [r[5], r[6]], s22: [r[7], r[8]] })) };
  };

  // scripts/textbook_exam/network.py low_frequency_line_impedance on the same files (numpy, 2026-11-21): the exam's
  // kit Touchstones as of 77d4a65, copied to tests/fixtures/exam-kits so a rerun of the exam does not move them.
  // network.py thru_line_calibration on the same files (numpy, 2026-11-21) with eps_eff guess 2.7, the line
  // impedance above and z0 50: [a, b, c, d] of the error box at kit points 15, 54, 93 and 120 (1.0 to 6.25 GHz, where the 48 mm line is usable).
  const pythonBoxes: Record<string, Array<[number, Complex[]]>> = {
    ro50: [
      [15, [[0.9167556774448171, 6.590643512158655e-05], [0.04102517018217052, 19.204101091817343], [5.9154211283970125e-06, 0.0075568264747602355], [0.9325038605526027, 0.00039506464500819885]]],
      [54, [[0.34375294564393444, -3.457653596399332e-05], [-0.020450964797764044, 45.24173452023044], [1.3526484286972694e-05, 0.018597687817555688], [0.46140124765153034, 0.0007202720346000138]]],
      [93, [[-0.4596747368769631, 0.0003824259917724371], [-0.08087954885101994, 43.90575313183274], [-6.955977295486583e-07, 0.02028544013027558], [-0.2378939002776196, 0.0034377198726221825]]],
      [120, [[-0.8951792484452661, -0.0018184575844821345], [-0.0889179864320473, 26.0452071916458], [-4.30942423522643e-05, 0.015265360699407787], [-0.672945469621352, 0.00413714572264978]]],
    ],
    ro22: [
      [15, [[0.8661569442385202, -0.0003342777514866021], [0.015355951904090852, 11.478532103646145], [-5.92516568698025e-06, 0.017236527577917205], [0.9261019974511856, 0.0005844702644082731]]],
      [54, [[-0.004377343299458706, 0.00019110315887905567], [-0.032950959939631784, 24.21791480727845], [5.922642486397196e-05, 0.04136507335895466], [0.4059750126278648, 0.001879462910505208]]],
      [93, [[-1.042905478914315, 0.002816223607920942], [-0.1509871082903196, 15.391579988481853], [5.705618873606543e-05, 0.04218310891977121], [-0.3363094453136441, 0.004356877589365834]]],
      [120, [[-1.3843005084200692, -0.005163638240628974], [-0.08957587106650058, -1.8893802989380728], [-0.0002010162242156269, 0.02835498161922218], [-0.7610837543958796, 0.004399399149198593]]],
    ],
  };
  it.each([['ro50', 47.52050549760011], ['ro22', 21.958882997290633]])('the %s kit gives the exam\'s error box, sign included', (kit, zLine) => {
    const thru = read(`kit-${kit}-thru`);
    const line48 = read(`kit-${kit}-line48`);
    const boxes = thruLineErrorBoxes(thru.f, thru.s, [{ extraMm: 48, s: line48.s }], 2.7, zLine, Z0);
    for (const [k, want] of pythonBoxes[kit]) {
      expect(boxes.lineUsed[k]).toBe(0);
      const got = boxes.box[k];
      [got.a, got.b, got.c, got.d].forEach((x, n) => close(x, want[n], 1e-9 * Math.max(1, Math.hypot(...want[n]))));
    }
  });

  it.each([['ro50', 47.52050549760011], ['ro22', 21.958882997290633]])('the %s kit gives the exam\'s line impedance', (kit, python) => {
    const thru = read(`kit-${kit}-thru`);
    const line48 = read(`kit-${kit}-line48`);
    expect(lowFrequencyLineImpedance(thru.f, thru.s, line48.s, Z0, 1.5).zOhm).toBeCloseTo(python, 9);
  });
});

describe('calibration band limits', () => {
  it('refuses a kit band the schema could not hold, and says what to change', () => {
    const analysis = { f_min_ghz: 0.01, f_max_ghz: 0.02, n_freq: 2, loss_reference_ghz: 0.015, stop: { energy_decay_db: 50, max_steps: 1000 } };
    expect(() => kitBand(analysis, 500, 12)).toThrow(/de-embed a shorter length/);
  });
});

/**
 * A 1.5 mm strip on a uniform 0.2 mm mesh whose board edges are not whole
 * cells from the ports: the port nodes sit 0.07 mm off the drawn ports, so a
 * kit drawn at the feed's nominal offsets would land on different cells.
 */
function offGridLine(direction: 'y' | 'x', highMm = 15) {
  const r = (x0: number, y0: number, x1: number, y1: number) => [[`${x0} mm`, `${y0} mm`], [`${x1} mm`, `${y0} mm`], [`${x1} mm`, `${y1} mm`], [`${x0} mm`, `${y1} mm`]];
  const flip = (q: number[][]) => q.map(([a, b]) => [b, a]);
  const pick = (x0: number, y0: number, x1: number, y1: number) => (direction === 'y' ? r(x0, y0, x1, y1) : flip(r(x0, y0, x1, y1).map((p) => p.map((s) => Number.parseFloat(s)))).map((p) => p.map((n) => `${n} mm`)));
  const outline = pick(-10.13, -15, 10.13, highMm);
  const at = (s: number) => (direction === 'y' ? { x: '0 mm', y: `${s} mm` } : { x: `${s} mm`, y: '0 mm' });
  const pml = { type: 'pml', cells: 6 };
  return {
    noburf_project: 1,
    name: `off-grid-${direction}`,
    variables: {},
    materials: { sub: { eps_r: 3.66, tan_delta: 0 } },
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'core', material: 'sub', thickness: '0.8 mm' },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline },
    geometry: { gnd: [{ id: 'g', op: 'add', polygon: outline }], top: [{ id: 'line', op: 'add', polygon: pick(-0.75, -15, 0.75, highMm) }] },
    ports: [
      { id: 'p1', ...at(-15), between: ['top', 'gnd'], reference_impedance_ohm: 50, deembed: { length: '10 mm' } },
      { id: 'p2', ...at(highMm), between: ['top', 'gnd'], reference_impedance_ohm: 50, deembed: { length: '10 mm' } },
    ],
    boundaries: { x_min: pml, x_max: pml, y_min: pml, y_max: pml, z_min: { type: 'pec' }, z_max: pml },
    mesh: { cell: '0.2 mm', air_margin_cells: { xy: 2, below: 2, above: 6 } },
    analysis: { f_min_ghz: 1, f_max_ghz: 10, n_freq: 10, loss_reference_ghz: 5, stop: { energy_decay_db: 40, max_steps: 4000 } },
    outputs: { zin_at_ghz: [] },
  };
}

/**
 * The strip's cross-section a few cells into the feed, as cell offsets from
 * the port's node in the feed's own frame (u into the feed, v = across(u)),
 * and the number of port columns.
 */
function feedCrossSection(model: ReturnType<typeof rasterise>['model'], portIndex: number, u: [number, number]) {
  const nx = model.grid.nx;
  const ny = model.grid.ny;
  const { i, j, columns } = model.ports[portIndex];
  const v: [number, number] = [-u[1], u[0]];
  const rows: number[][] = [];
  for (const s of [1, 3, 5]) {
    const row: number[] = [];
    for (let t = -12; t <= 12; t++) {
      // Cell whose centre is (s + 0.5, t + 0.5) cells from the node in (u, v).
      const ci = Math.floor(i + (s + 0.5) * u[0] + (t + 0.5) * v[0]);
      const cj = Math.floor(j + (s + 0.5) * u[1] + (t + 0.5) * v[1]);
      if (ci >= 0 && ci < nx && cj >= 0 && cj < ny && model.topCopper[ci + nx * cj]) row.push(t);
    }
    rows.push(row);
  }
  // Ez coefficients in the substrate on the nodes around the port: board, strip and air as the solver sees them.
  const ez: number[] = [];
  for (let s = -2; s <= 3; s++) {
    for (let t = -8; t <= 8; t++) {
      const ci = i + s * u[0] + t * v[0];
      const cj = j + s * u[1] + t * v[1];
      const inside = ci >= 0 && ci < nx && cj >= 0 && cj < ny;
      ez.push(inside ? Number(model.eCurl[2 * nx * ny * model.grid.nz + idx3(model.grid, ci, cj, model.ports[portIndex].k0)].toPrecision(6)) : NaN);
    }
  }
  return { rows, columns, ez };
}

describe('the kit on a uniform mesh', () => {
  const into: Record<string, [number, number]> = { '+x': [1, 0], '-x': [-1, 0], '+y': [0, 1], '-y': [0, -1] };
  // 15.07: the far board edge 0.07 mm past port 2's node, so the cell behind that port is air.
  it.each([['y', 0, 15], ['y', 1, 15], ['x', 0, 15], ['x', 1, 15], ['y', 1, 15.07], ['x', 1, 15.07]] as const)('puts the board and strip of a %s feed (port %i, board to %s mm) on the same cells, from the port node, as the project', (direction, index, highMm) => {
    const project = parseProject(offGridLine(direction, highMm));
    const feed = readFeed(resolveProject(project), index);
    const kit = parseProject(JSON.parse(JSON.stringify(kitProject(project, feed, 4, kitBand(project.analysis, 10, 3.66), 'thru'))));
    const inProject = feedCrossSection(rasterise(project).model, index, into[feed.direction]);
    const inKit = feedCrossSection(rasterise(kit).model, 0, into[`+${feed.direction[1]}`]);
    expect(inProject.rows[0].length).toBeGreaterThan(5);
    expect(inKit).toEqual(inProject);
  });
});
