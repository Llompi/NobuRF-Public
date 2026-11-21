import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCITATION, timestepSec } from '../src/engine/config';
import { addCoaxFeed } from '../src/engine/coax_feed';
import {
  anchoredResponse, constantResponse, DispersionBuilder, djordjevicSarkarExact, djordjevicSarkarResponse, mediumRecord, poleUpdate,
  relativeValue, type Complex, type DjordjevicSarkar, type MediumResponse,
} from '../src/engine/dispersion';
import { CpuFdtd, pecBoxModel } from '../src/engine/fdtd_cpu';
import { rasterise } from '../src/project/rasterise';
import { parseProject, ProjectError } from '../src/project/schema';
import { lineFromColumn, measureSlab, measureSlabLine, SLAB_DEFAULT, type SlabMaterial } from '../scripts/validate/dispersive_slab';
import { shortestWavelength } from '../src/project/materials';
import { resolveProject } from '../src/project/resolve';
import { dispersiveProjectJson, rect, smallProjectJson, smaEdgeLineJson } from './project_fixtures';

const slow = process.env.SKIP_SLOW ? it.skip : it;

const FR4_DS: DjordjevicSarkar = { epsR: 4.4, tanDelta: 0.02, atHz: 1e9, fLowHz: 1e3, fHighHz: 1e12 };

/**
 * Kramers-Kronig: eps'(w) - eps(inf) = (2 / pi) PV integral_0^inf x eps''(x) / (x^2 - w^2) dx.
 * With x = w e^u the principal value folds u and -u together:
 *   (2 / pi) integral_0^inf (f(u) e^2u - f(-u)) / (e^2u - 1) du,  f(u) = eps''(w e^u),
 * which is finite at u = 0. Midpoint rule; eps'' falls off at both ends.
 */
function kramersKronigReal(lossAt: (fHz: number) => number, fHz: number): number {
  const du = 2e-3;
  let sum = 0;
  for (let u = du / 2; u < 45; u += du) {
    const e2u = Math.exp(2 * u);
    sum += (lossAt(fHz * Math.exp(u)) * e2u - lossAt(fHz * Math.exp(-u))) / (e2u - 1);
  }
  return (2 / Math.PI) * sum * du;
}

describe('Djordjevic-Sarkar model', () => {
  it('has eps_r and tan_delta at the measurement frequency, and nearly flat loss across the decades', () => {
    const [re, im] = djordjevicSarkarExact(FR4_DS, FR4_DS.atHz);
    expect(re).toBeCloseTo(4.4, 12);
    expect(-im / re).toBeCloseTo(0.02, 12);
    // eps' falls about 3 % per decade (k = eps'' 2 ln10 / pi per decade), eps'' stays within 1 %.
    const [re10, im10] = djordjevicSarkarExact(FR4_DS, 10e9);
    expect(re - re10).toBeGreaterThan(0.1);
    expect(re - re10).toBeLessThan(0.15);
    expect(Math.abs(im10 / im - 1)).toBeLessThan(0.01);
  });

  it('is causal: its real part is the Kramers-Kronig transform of its loss (to 1e-4)', () => {
    const highFrequencyLimit = djordjevicSarkarExact(FR4_DS, 1e20)[0];
    for (const f of [1e6, 1e9, 6e9, 30e9]) {
      const fromLoss = highFrequencyLimit + kramersKronigReal((x) => -djordjevicSarkarExact(FR4_DS, x)[1], f);
      expect(Math.abs(fromLoss - djordjevicSarkarExact(FR4_DS, f)[0])).toBeLessThan(1e-4);
    }
  });

  it('the Debye-pole fit matches the closed form across the band: eps\' to 1e-4, eps\'\' to 0.3 %', () => {
    for (const [fMin, fMax] of [[1e9, 10e9], [0.1e9, 20e9], [10e6, 1e9]]) {
      const fit = djordjevicSarkarResponse(FR4_DS, fMin, fMax);
      expect(fit.lossRate).toBe(0);
      for (let n = 0; n <= 100; n++) {
        const f = fMin * (fMax / fMin) ** (n / 100);
        const [er, ei] = djordjevicSarkarExact(FR4_DS, f);
        const [fr, fi] = relativeValue(fit, f);
        expect(Math.abs(fr - er) / er).toBeLessThan(1e-4);
        expect(Math.abs(fi - ei) / -ei).toBeLessThan(3e-3);
      }
    }
  });

  it('with a corner of the model near the band, the fit still holds (eps\' 1e-4, eps\'\' 0.3 %)', () => {
    for (const [fLowHz, fHighHz, fMin, fMax] of [[1e8, 2e9, 0.5e9, 10e9], [1e6, 1e10, 1e9, 20e9]]) {
      const m = { ...FR4_DS, fLowHz, fHighHz };
      const fit = djordjevicSarkarResponse(m, fMin, fMax);
      for (let n = 0; n <= 100; n++) {
        const f = fMin * (fMax / fMin) ** (n / 100);
        const [er, ei] = djordjevicSarkarExact(m, f);
        const [fr, fi] = relativeValue(fit, f);
        expect(Math.abs(fr - er) / er).toBeLessThan(1e-4);
        expect(Math.abs(fi - ei) / -ei).toBeLessThan(3e-3);
      }
    }
  });

  it('a lossless Djordjevic-Sarkar material is a constant', () => {
    expect(djordjevicSarkarResponse({ ...FR4_DS, tanDelta: 0 }, 1e9, 10e9)).toEqual(constantResponse(4.4));
  });

  it('the fit is causal too (a Debye sum), so Kramers-Kronig holds for it as well', () => {
    const fit = djordjevicSarkarResponse(FR4_DS, 1e9, 10e9);
    for (const f of [2e9, 6e9]) {
      const fromLoss = fit.inf + kramersKronigReal((x) => -relativeValue(fit, x)[1], f);
      expect(Math.abs(fromLoss - relativeValue(fit, f)[0])).toBeLessThan(1e-3);
    }
  });
});

describe('pole responses', () => {
  it('anchoring puts the material exactly on eps_r and tan_delta at at_ghz', () => {
    const r = anchoredResponse(3, 0.2, 2e9, [{ type: 'debye', delta: 1, fRelaxHz: 1e9 }, { type: 'lorentz', delta: 0.3, fResHz: 5e9, dampingHz: 1e9 }], 'x');
    const [re, im] = relativeValue(r, 2e9);
    expect(re).toBeCloseTo(3, 12);
    expect(-im / re).toBeCloseTo(0.2, 12);
    expect(r.lossRate).toBeGreaterThan(0);
  });

  it('refuses poles that leave less than 1 at high frequency, or more loss than asked for', () => {
    expect(() => anchoredResponse(2, 0, 1e9, [{ type: 'debye', delta: 3, fRelaxHz: 1e10 }], 'eps')).toThrow(/at least 1/);
    expect(() => anchoredResponse(4, 0.001, 1e9, [{ type: 'debye', delta: 1, fRelaxHz: 1e9 }], 'eps')).toThrow(/lossier/);
  });

  it('a Lorentz pole too fast for the time step is refused, counting how strongly it couples', () => {
    const lorentz = (delta: number, fResHz: number): MediumResponse => ({ inf: 1, lossRate: 0, poles: [{ type: 'lorentz', delta, fResHz, dampingHz: 0 }] });
    const dt = 1e-12;
    expect(() => mediumRecord(lorentz(1, 1e11), dt)).not.toThrow(); // w0 dt 0.63, coupled 0.89
    expect(() => mediumRecord(lorentz(3, 1e11), dt)).toThrow(/too fast/); // coupled 1.26
    expect(() => mediumRecord(lorentz(100, 2e10), dt)).toThrow(/too fast/); // w0 dt 0.13, coupled 1.26
  });

  it('a strong Lorentz pole that passes the check stays bounded for 20k steps', () => {
    // 0-D: the field update with D = 0 from a kick, the worst case for the explicit pole.
    const dt = 1e-12;
    const rec = mediumRecord({ inf: 1, lossRate: 0, poles: [{ type: 'lorentz', delta: 100, fResHz: 1.5e10, dampingHz: 0 }] }, dt);
    let [f, p, pp] = [1, 0, 0];
    let peak = 0;
    for (let n = 0; n < 20000; n++) {
      const hist = rec[4] * p + rec[5] * pp;
      const next = rec[0] * f + rec[1] * -hist;
      [pp, p] = [p, p + rec[4] * p + rec[5] * pp + rec[6] * next + rec[7] * f];
      f = next;
      peak = Math.max(peak, Math.abs(f));
    }
    expect(peak).toBeLessThan(10);
  });

  it('the discrete pole recursions converge to the continuous susceptibility as dt -> 0', () => {
    // z-transform of p' = a1 p + a2 p_prev + b0 f' + b1 f at z = exp(j w dt): chi = (b0 z + b1) / (z - a1 - a2 / z).
    const discrete = (u: ReturnType<typeof poleUpdate>, w: number, dt: number): Complex => {
      const z: Complex = [Math.cos(w * dt), Math.sin(w * dt)];
      const zi: Complex = [z[0], -z[1]];
      const num: Complex = [u.b0 * z[0] + u.b1, u.b0 * z[1]];
      const den: Complex = [z[0] - u.a1 - u.a2 * zi[0], z[1] - u.a2 * zi[1]];
      const q = den[0] ** 2 + den[1] ** 2;
      return [(num[0] * den[0] + num[1] * den[1]) / q, (num[1] * den[0] - num[0] * den[1]) / q];
    };
    const dt = 5e-13; // the 0.25 mm grid's step
    for (const pole of [{ type: 'debye', delta: 3, fRelaxHz: 3e9 }, { type: 'lorentz', delta: 1.5, fResHz: 7e9, dampingHz: 1e9 }] as const) {
      for (const f of [1e9, 5e9, 10e9]) {
        const [dr, di] = discrete(poleUpdate(pole, dt), 2 * Math.PI * f, dt);
        const [cr, ci] = relativeValue({ inf: 0, lossRate: 0, poles: [pole] }, f);
        expect(Math.hypot(dr - cr, di - ci) / Math.hypot(cr, ci)).toBeLessThan(2e-3);
      }
    }
  });
});

describe('the ADE update in the FDTD loop', () => {
  it('a listed edge with a constant medium gives the same fields as the plain lossy update', () => {
    // The FR-4 patch with every substrate E edge listed as its own constant medium: bit-close to the unlisted model.
    const plain = rasterise(parseProject(smallProjectJson())).model;
    const N = plain.grid.nx * plain.grid.ny * plain.grid.nz;
    const builder = new DispersionBuilder(timestepSec(plain.grid));
    const media = new Map<string, MediumResponse>();
    for (let e = 0; e < 3 * N; e++) {
      const curl = plain.eCurl[e];
      if (curl === 0 || (plain.eDecay[e] === 1 && Math.abs(curl - plain.grid.courant) < 1e-7)) continue;
      // Invert dielectricEdge: eps (1 + s / (2 eps)) = Sc / curl and decay = (1 - h) / (1 + h), h = s / (2 eps).
      const half = (1 - plain.eDecay[e]) / (1 + plain.eDecay[e]);
      const eps = plain.grid.courant / (curl * (1 + half));
      const key = `${eps}:${half}`;
      if (!media.has(key)) media.set(key, constantResponse(eps, (2 * eps * half) / timestepSec(plain.grid)));
      builder.add(e, [{ response: media.get(key)!, weight: 1 }]);
    }
    const listed = { ...plain, dispersion: { e: builder.build() } };
    const control = { maxSteps: 600, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
    const a = new CpuFdtd(plain).run(DEFAULT_EXCITATION, control).v;
    const b = new CpuFdtd(listed).run(DEFAULT_EXCITATION, control).v;
    const peak = Math.max(...a.map(Math.abs));
    expect(Math.max(...a.map((v, n) => Math.abs(v - b[n])))).toBeLessThan(1e-4 * peak);
  });

  const C = constantResponse;
  const SLABS: Record<string, SlabMaterial> = {
    'constant eps 4': { eps: C(4), mu: C(1) },
    'Debye eps': { eps: { inf: 2, lossRate: 0, poles: [{ type: 'debye', delta: 3, fRelaxHz: 3e9 }] }, mu: C(1) },
    'Lorentz eps, through resonance': { eps: { inf: 1.5, lossRate: 0, poles: [{ type: 'lorentz', delta: 1.5, fResHz: 7e9, dampingHz: 1e9 }] }, mu: C(1) },
    'lossy constant mu 4': { eps: C(2), mu: C(4, 2e9) },
    'Lorentz mu, through resonance': { eps: C(2), mu: { inf: 1, lossRate: 0, poles: [{ type: 'lorentz', delta: 3, fResHz: 6e9, dampingHz: 2e9 }] } },
    'Djordjevic-Sarkar FR-4': { eps: djordjevicSarkarResponse(FR4_DS, 1e9, 11e9), mu: C(1) },
  };
  const FREQS = [2e9, 4e9, 6e9, 8e9, 10e9];
  for (const [name, material] of Object.entries(SLABS)) {
    it(`slab of ${name}: reflection and transmission within 0.006 of the closed form, 2-10 GHz`, () => {
      for (const r of measureSlab(material, FREQS)) {
        expect(Math.hypot(r.gamma[0] - r.exact.gamma[0], r.gamma[1] - r.exact.gamma[1])).toBeLessThan(6e-3);
        expect(Math.hypot(r.t[0] - r.exact.t[0], r.t[1] - r.exact.t[1])).toBeLessThan(6e-3);
      }
    });
  }

  it('a slab with eps(w) = mu(w) is matched to free space at every frequency (|Gamma| < 2e-3)', () => {
    const lorentz: MediumResponse = { inf: 1.2, lossRate: 3e8, poles: [{ type: 'lorentz', delta: 2, fResHz: 5e9, dampingHz: 2e9 }] };
    for (const r of measureSlab({ eps: lorentz, mu: lorentz }, FREQS)) expect(Math.hypot(...r.gamma)).toBeLessThan(2e-3);
  });
});

describe('the energy stop counts the energy held in the poles', () => {
  /** A 16 x 14 x 12 PEC box filled with `medium`, rung by a zero-mean pulse on Ez; energy() and the plain eps e^2 + h^2 every 400 steps. */
  function ringBox(medium: MediumResponse) {
    const grid = { nx: 16, ny: 14, nz: 12, dxMm: 1, courant: 0.5, pmlCells: 0, groundK: 0, stepsPerRun: 0 };
    const box = pecBoxModel(grid, 1);
    const N = grid.nx * grid.ny * grid.nz;
    const builder = new DispersionBuilder(timestepSec(grid));
    for (let e = 0; e < 3 * N; e++) if (box.eCurl[e] !== 0) builder.add(e, [{ response: medium, weight: 1 }]);
    const solver = new CpuFdtd({ ...box, dispersion: { e: builder.build() } });
    const source = 2 * N + 8 + grid.nx * (7 + grid.ny * 6);
    const full: number[] = [];
    const plain: number[] = [];
    for (let n = 1; n <= 4000; n++) {
      solver.updateH();
      solver.updateE();
      // The derivative of a Gaussian: no DC, which a closed box would keep as a static field.
      if (n < 200) solver.e[source] -= ((n - 80) / 25) * Math.exp(-(((n - 80) / 25) ** 2));
      if (n % 400 === 0) {
        full.push(solver.energy());
        plain.push(solver.e.reduce((s, x, e) => s + (box.eCurl[e] === 0 ? 0 : x * x), 0) + solver.h.reduce((s, x) => s + x * x, 0));
      }
    }
    return { full, plain };
  }

  it('a lossless Lorentz medium keeps its total energy while the field energy swings into the pole and back', () => {
    const { full, plain } = ringBox({ inf: 1.5, lossRate: 0, poles: [{ type: 'lorentz', delta: 2, fResHz: 5e9, dampingHz: 0 }] });
    const mean = full.reduce((a, b) => a + b) / full.length;
    for (const x of full) expect(Math.abs(x / mean - 1)).toBeLessThan(0.06);
    expect(Math.max(...plain) / Math.min(...plain)).toBeGreaterThan(5);
  });

  it('a slow Debye medium only loses energy, and holds more of it than the field alone', () => {
    const { full, plain } = ringBox({ inf: 2, lossRate: 0, poles: [{ type: 'debye', delta: 3, fRelaxHz: 0.2e9 }] });
    for (let n = 1; n < full.length; n++) expect(full[n]).toBeLessThan(full[n - 1]);
    full.forEach((x, n) => expect(x).toBeGreaterThan(plain[n]));
  });
});

describe('dispersive materials in the project file', () => {
  it('rasterise lists the dispersive E edges and the magnetic H edges, with interface mixes', () => {
    const { model } = rasterise(parseProject(dispersiveProjectJson()));
    const d = model.dispersion!;
    expect(d.e!.index.length).toBeGreaterThan(0);
    expect(d.h!.index.length).toBeGreaterThan(0);
    // The D-S fit's poles, plus the ferrite's Debye pole on the plane where they meet the cover above the copper.
    expect(d.e!.maxPoles).toBeGreaterThan(5);
    // Every listed E edge is on the board and not copper; port cells are listed but have eCurl 0.
    const portCells = new Set(model.ports.flatMap((p) => [...p.ezIndex]));
    for (const e of d.e!.index) expect(model.eCurl[e] !== 0 || portCells.has(e)).toBe(true);
    // The material changes the run against plain FR-4.
    expect(model.signature).not.toBe(rasterise(parseProject(smallProjectJson())).model.signature);
  });

  it('a plain project has no dispersion and keeps its signature', () => {
    expect(rasterise(parseProject(smallProjectJson())).model.dispersion).toBeUndefined();
  });

  it('reads the material models and names the path of a bad one', () => {
    const bad = (materials: Record<string, unknown>) => {
      const json = smallProjectJson();
      json.materials = materials;
      json.stackup[1].material = Object.keys(materials)[0];
      return () => parseProject(json);
    };
    expect(bad({ m: { eps_r: 4, tan_delta: 0.01, dispersion: { model: 'cole' } } })).toThrow(/\$\.materials\.m\.dispersion\.model/);
    expect(bad({ m: { eps_r: 4, tan_delta: 0.01, mu_dispersion: { model: 'poles', at_ghz: 1, poles: [{ type: 'debye', delta: 1, f_relax_ghz: 1 }] } } }))
      .toThrow(/needs mu_r/);
    expect(bad({ m: { eps_r: 2, tan_delta: 0, dispersion: { model: 'poles', at_ghz: 1, poles: [{ type: 'debye', delta: 5, f_relax_ghz: 100 }] } } }))
      .toThrow(ProjectError);
    expect(bad({ m: { eps_r: 4, tan_delta: 0.01, dispersion: { model: 'poles', at_ghz: 1, poles: [] } } })).toThrow(/1 to 8 poles/);
  });

  it('two layers of one material share its pole set, on the plane between them too', () => {
    const json = dispersiveProjectJson();
    json.stackup.splice(1, 1,
      { type: 'dielectric', name: 'core_a', material: 'FR-4 wideband', thickness: '1 mm' },
      { type: 'dielectric', name: 'core_b', material: 'FR-4 wideband', thickness: '1 mm' });
    json.ports[0].between = ['top', 'gnd'];
    json.stackup.push({ type: 'dielectric', name: 'cover_b', material: 'ferrite', thickness: '1 mm' });
    const single = rasterise(parseProject(dispersiveProjectJson())).model.dispersion!;
    const d = rasterise(parseProject(json)).model.dispersion!;
    expect(d.e!.maxPoles).toBe(single.e!.maxPoles);
    // Hz between the two ferrite layers keeps the Lorentz pole (a series mean would have none).
    expect(d.h!.maxPoles).toBe(1);
  });

  it('refuses a material whose stand-in at the loss reference is below 1, and a Lorentz pole too fast for the grid', () => {
    const json = smallProjectJson();
    // Just above a strong resonance at 11.5 GHz, eps' is negative at the 12 GHz loss reference.
    json.materials = { m: { eps_r: 3.6, tan_delta: 0.01, dispersion: { model: 'poles', at_ghz: 1, poles: [{ type: 'lorentz', delta: 2, f_res_ghz: 11.5, damping_ghz: 0.5 }] } } };
    json.stackup[1].material = 'm';
    expect(() => rasterise(parseProject(json))).toThrow(/\$\.materials\.m: εr′ is -/);
    json.materials = { m: { eps_r: 4.4, tan_delta: 0.02, mu_r: 102, mu_tan_delta: 0.01, mu_dispersion: { model: 'poles', at_ghz: 1, poles: [{ type: 'lorentz', delta: 100, f_res_ghz: 80, damping_ghz: 1 }] } } };
    expect(() => rasterise(parseProject(json))).toThrow(/\$\.materials\.m: Lorentz pole .* too fast/);
  });

  it('a constant mu_r makes magnetic edges with no poles; mu_r 1 makes none', () => {
    const json = smallProjectJson();
    json.materials = { m: { eps_r: 4.4, tan_delta: 0.02, mu_r: 5 } };
    json.stackup[1].material = 'm';
    const h = rasterise(parseProject(json)).model.dispersion!.h!;
    expect(h.maxPoles).toBe(0);
    json.materials.m.mu_r = 1;
    expect(rasterise(parseProject(json)).model.dispersion).toBeUndefined();
  });

  slow('a coax connector takes the edges it repaints off the dispersive list', () => {
    const json = smaEdgeLineJson();
    json.materials = { ...json.materials, ds: { eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'djordjevic_sarkar', at_ghz: 1 } } };
    for (const layer of json.stackup) if (layer.type === 'dielectric') layer.material = 'ds';
    const { model: board, coaxPorts } = rasterise(parseProject(json));
    const { model } = addCoaxFeed(board, coaxPorts[0].spec);
    const before = board.dispersion!.e!.index.length;
    const after = model.dispersion!.e!.index.length;
    expect(after).toBeLessThan(before);
    expect(model.signature).not.toBe(board.signature);
  });
  it('a slab built through the project file matches the closed form: rasterise\'s stand-in, interface mix and H edges', () => {
    // A 10 mm slab of a Debye dielectric with a lossy Lorentz permeability between 1 mm of air above and below
    // (the port sits in the air below, on a pad in a corner), on 0.25 mm cells like the line. The slab's column at the board centre is laid along the line.
    const json = smallProjectJson();
    json.materials = {
      slab: {
        eps_r: 3, tan_delta: 0.25, dispersion: { model: 'poles', at_ghz: 6, poles: [{ type: 'debye', delta: 1.5, f_relax_ghz: 4 }] },
        mu_r: 2, mu_tan_delta: 0.2, mu_dispersion: { model: 'poles', at_ghz: 6, poles: [{ type: 'lorentz', delta: 0.5, f_res_ghz: 20, damping_ghz: 5 }] },
      },
    };
    json.stackup = [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'below', material: 'air', thickness: '1 mm' },
      { type: 'copper', name: 'mid', material: 'pec' },
      { type: 'dielectric', name: 'slab', material: 'slab', thickness: '10 mm' },
      { type: 'dielectric', name: 'above', material: 'air', thickness: '1 mm' },
    ];
    json.variables = {};
    json.board = { outline: rect('-1 mm', '-1 mm', '1 mm', '1 mm') };
    json.geometry = { gnd: [{ id: 'ground', op: 'add', polygon: rect('-1 mm', '-1 mm', '1 mm', '1 mm') }], mid: [{ id: 'pad', op: 'add', polygon: rect('-1 mm', '-1 mm', '-0.5 mm', '-0.5 mm') }] };
    json.ports = [{ id: 'p1', x: '-0.75 mm', y: '-0.75 mm', between: ['mid', 'gnd'], reference_impedance_ohm: 50 }];
    json.mesh = { cell: '0.25 mm', air_margin_cells: { xy: 2, below: 2, above: 6 } };
    json.analysis = { ...json.analysis, f_min_ghz: 2, f_max_ghz: 10, loss_reference_ghz: 6 };
    json.outputs = { zin_at_ghz: [6] };
    const project = parseProject(json);
    const layer = resolveProject(project).stackup.find((l) => l.name === 'slab');
    if (layer?.type !== 'dielectric') throw new Error('no slab layer');
    const material = { eps: layer.responses.permittivity!, mu: layer.responses.permeability! };
    const { model } = rasterise(project);
    const column = { i: Math.floor(model.grid.nx / 2), j: Math.floor(model.grid.ny / 2) };
    // The slab's planes, from the mesh lines: 1 mm and 11 mm above the ground plane.
    const planeAt = (mm: number) => model.mesh.z.findIndex((z) => Math.abs(z - model.mesh.z[model.grid.groundK] - mm) < 1e-9);
    const slab = { kBottom: planeAt(1), kTop: planeAt(11) };
    // Measured 1.3e-3 for both polarisations; a face edge given the whole slab instead of the half-and-half mix reads 2e-2, no H edges 0.8.
    for (const polarisation of ['x', 'y'] as const) {
      const line = lineFromColumn(model, column, slab, SLAB_DEFAULT, polarisation);
      // The column is on the board: its slab edges are listed, and the two faces carry their own mixes.
      expect(new Set(line.model.dispersion!.e!.medium).size).toBeGreaterThanOrEqual(2);
      // One magnetic H edge per slab cell, on each of the line's 2 x 2 rows.
      expect(line.model.dispersion!.h!.index.length).toBe(SLAB_DEFAULT.cells * 4);
      for (const r of measureSlabLine(line, material, [2e9, 4e9, 6e9, 8e9, 10e9], SLAB_DEFAULT)) {
        expect(Math.hypot(r.gamma[0] - r.exact.gamma[0], r.gamma[1] - r.exact.gamma[1])).toBeLessThan(3e-3);
        expect(Math.hypot(r.t[0] - r.exact.t[0], r.t[1] - r.exact.t[1])).toBeLessThan(3e-3);
      }
    }
  });
  it('warns when a layer is coarse for the wavelength inside it, and names what magnetic layers approximate', () => {
    // εr 12, μr 4 on 0.5 mm cells at 10 GHz: 30 mm in vacuum but 4.3 mm in the material, about 9 cells.
    const json = smallProjectJson();
    json.materials = { m: { eps_r: 12, tan_delta: 0.01, mu_r: 4 } };
    json.stackup[1].material = 'm';
    json.mesh.cell = '0.5 mm';
    json.analysis = { ...json.analysis, f_min_ghz: 2, f_max_ghz: 10, loss_reference_ghz: 6 };
    json.outputs = { zin_at_ghz: [6] };
    const warnings = rasterise(parseProject(json)).warnings;
    expect(warnings.some((w) => /layer "core": 8\.\d cells per wavelength inside the material/.test(w))).toBe(true);
    expect(warnings.some((w) => /energy stop .* as if μr were 1/.test(w))).toBe(true);
    // A constant μr has no poles to lose on the faces.
    expect(warnings.some((w) => /series mean/.test(w))).toBe(false);
    // The ferrite cover's Lorentz pole meets air above and copper-plane FR-4 below.
    const ferrite = rasterise(parseProject(dispersiveProjectJson())).warnings;
    expect(ferrite.some((w) => /layer "cover": Hz on a face .* series mean/.test(w))).toBe(true);
    // Plain FR-4 at 0.5 mm and 10 GHz has about 29 cells per wavelength: no material warning.
    json.materials = {};
    json.stackup[1].material = 'FR-4';
    expect(rasterise(parseProject(json)).warnings.filter((w) => /cells per wavelength|magnetic/.test(w))).toEqual([]);
  });
  it('takes the shortest wavelength in the material over the band, so a resonance inside it counts', () => {
    // A Lorentz pole at 8 GHz in a 1-10 GHz band: eps' is negative at 10 GHz, but near 8 GHz the index is about 16.
    const lorentz: MediumResponse = { inf: 2, lossRate: 0, poles: [{ type: 'lorentz', delta: 20, fResHz: 8e9, dampingHz: 1e9 }] };
    const s = shortestWavelength(2, { permittivity: lorentz, permeability: null }, 1e9, 10e9);
    expect(s.atHz).toBeGreaterThan(7e9);
    expect(s.atHz).toBeLessThan(8.5e9);
    expect(s.index).toBeGreaterThan(10);
    // A plain substrate: lambda0 / sqrt(eps_r) at f_max.
    const plain = shortestWavelength(4, { permittivity: null, permeability: null }, 1e9, 10e9);
    expect(plain.atHz).toBe(10e9);
    expect(plain.wavelengthMm).toBeCloseTo(299.792458 / 10 / 2, 9);
  });
});

