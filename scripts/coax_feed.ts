/**
 * Lumped port vs a modelled edge-launch SMA on the same board and the same mesh.
 *
 *   npx tsx scripts/coax_feed.ts <project.json> --feed lumped|coax [--out file.json] [--field-ghz f] [--dry]
 *
 * The project's feed trace is extended to the board edge (the connector sits
 * there) and its lumped port moved onto the board edge, so both feeds drive the
 * same copper at the same plane. Both runs use the mesh with the connector's
 * refinements, so the only difference between them is the feed.
 *   lumped : the 50 ohm lumped port at the board edge (CpuFdtd).
 *   coax   : the port removed, the SMA modelled (coax_feed.ts), S11 de-embedded to the flange.
 * --dry prints the mesh and exits. Results: fGHz, S11 (dB re 50 ohm), Z_in.
 * --field-ghz adds the steady-state Ey, Ez phasor at that frequency on the
 * plane through the feed centre (x = port x), for figures.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { ENERGY_STOP_RUN, timestepSec } from '../src/engine/config';
import { addCoaxFeed, coaxImpedanceOhm, coaxRefinements, edgeLaunchSma, solveCoaxFeed } from '../src/engine/coax_feed';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { smallestCell } from '../src/engine/mesh';
import { PlanePhasorRecorder } from '../src/engine/plane_phasor';
import { portSpectrum } from '../src/engine/port_dft';
import type { ExcitationConfig } from '../src/engine/types';
import { rasterise } from '../src/project/rasterise';
import { resolveProject } from '../src/project/resolve';
import { parseProject } from '../src/project/schema';

/** Cell across the coax: 0.125 mm (10 across the pin) lands on the copper and layer lines of the validation patch. COAX_CROSS_CELL_MM overrides it. */
const CROSS_CELL_MM = Number(process.env.COAX_CROSS_CELL_MM ?? 0.125);

const USAGE = 'usage: tsx scripts/coax_feed.ts <project.json> --feed lumped|coax [--out file.json] [--field-ghz f] [--dry]';

function parseArgs(argv: string[]) {
  const [projectPath, ...rest] = argv;
  if (!projectPath) throw new Error(USAGE);
  let feed: 'lumped' | 'coax' | null = null;
  let out: string | null = null;
  let dry = false;
  let fieldGHz: number | null = null;
  for (let n = 0; n < rest.length; n++) {
    if (rest[n] === '--feed' && (rest[n + 1] === 'lumped' || rest[n + 1] === 'coax')) feed = rest[++n] as 'lumped' | 'coax';
    else if (rest[n] === '--out' && rest[n + 1]) out = rest[++n];
    else if (rest[n] === '--dry') dry = true;
    else if (rest[n] === '--field-ghz' && Number(rest[n + 1]) > 0) fieldGHz = Number(rest[++n]);
    else throw new Error(USAGE);
  }
  if (!feed) throw new Error(USAGE);
  return { projectPath, feed, out, dry, fieldGHz };
}

/**
 * The validation patch with its feed trace running to the board edge and the
 * port there. The trace is the "feed" shape, from -L/2 - flen; flen becomes
 * the distance to the board edge.
 */
function edgeFedProject(json: any) {
  const r = resolveProject(parseProject(json));
  const boardEdge = Math.min(...r.boardOutline.map((p) => p[1]));
  const patchL = Number.parseFloat(json.variables.L.value);
  json.variables.flen = { value: `${-boardEdge - patchL / 2} mm` };
  json.ports[0].y = `${boardEdge} mm`;
  return { project: parseProject(json), boardEdge };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { project, boardEdge } = edgeFedProject(JSON.parse(readFileSync(args.projectPath, 'utf8')));
  const resolved = resolveProject(project);
  const copperZ = [0, ...resolved.stackup.filter((l) => l.type === 'dielectric').map((l) => (l as { thicknessMm: number }).thicknessMm)]
    .map((_, n, a) => a.slice(0, n + 1).reduce((s, v) => s + v, 0));
  const topZ = copperZ.at(-1)!;
  const spec = edgeLaunchSma({ edge: 'y_min', alongMm: resolved.ports[0].xMm, topCopperZMm: topZ, groundZMm: copperZ[0], boardEdgeMm: boardEdge });
  const [x, y, z] = coaxRefinements(spec, { crossCellMm: [CROSS_CELL_MM, CROSS_CELL_MM], runCellMm: 0.5, copperZMm: copperZ });
  const refinements = { x, y, z };
  const { model: board, warnings } = rasterise(project, { refinements });
  const { nx, ny, nz } = board.grid;
  console.log(`mesh ${nx} x ${ny} x ${nz} = ${(nx * ny * nz / 1e6).toFixed(2)} M cells, smallest ${smallestCell(board.mesh).toFixed(3)} mm`);
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (args.dry) {
    const { feed } = addCoaxFeed(board, spec);
    console.log(`coax line ${feed.probes[1].impedanceOhm.toFixed(2)} ohm on this mesh (round-coax formula ${coaxImpedanceOhm(spec.pinRadiusMm, spec.boreRadiusMm, spec.dielectricEpsR).toFixed(2)} ohm)`);
    return;
  }

  const exc: ExcitationConfig = {
    fMinGHz: project.analysis.f_min_ghz, fMaxGHz: project.analysis.f_max_ghz, nFreq: project.analysis.n_freq, z0: project.ports[0].reference_impedance_ohm,
  };
  const control = { ...ENERGY_STOP_RUN, maxSteps: project.analysis.stop.max_steps, stopAtEnergyDecayDb: project.analysis.stop.energy_decay_db };
  const t0 = Date.now();
  const axisI = board.mesh.x.findIndex((x) => Math.abs(x - spec.axisMm[0]) < 1e-9);
  if (axisI < 0) throw new Error(`no mesh line at the coax axis x = ${spec.axisMm[0]} mm`);
  const field = args.fieldGHz === null ? undefined : new PlanePhasorRecorder(board.grid, axisI, args.fieldGHz * 1e9, timestepSec(board.grid));
  let result: Record<string, unknown>;
  if (args.feed === 'lumped') {
    const run = new CpuFdtd(board).run(exc, control, field);
    const s = portSpectrum({ v: run.ports[0].v, i: run.ports[0].i, dtSec: run.dtSec }, exc);
    result = { steps: run.ports[0].v.length, fGHz: [...s.fGHz], s11Db: [...s.s11Db], zRe: [...s.zRe], zIm: [...s.zIm] };
  } else {
    const { reflection: r, feedRun } = solveCoaxFeed(board, spec, exc, control, field);
    result = {
      steps: feedRun.steps, lineImpedanceOhm: r.lineImpedanceOhm, fGHz: [...r.fGHz], s11Db: [...r.s11Db], zRe: [...r.zRe], zIm: [...r.zIm],
      gammaRe: [...r.gammaRe], gammaIm: [...r.gammaIm], betaPerMm: [...r.betaPerMm],
    };
  }
  const s11 = result.s11Db as number[];
  const f = result.fGHz as number[];
  const k = s11.indexOf(Math.min(...s11));
  const topCopperEndYMm = Number.parseFloat(project.variables.L.value) / 2;
  const summary = {
    project: project.name, feed: args.feed, cells: nx * ny * nz, seconds: (Date.now() - t0) / 1000, f0GHz: f[k], s11MinDb: s11[k], spec,
    topCopperZMm: topZ, topCopperEndYMm,
  };
  console.log(JSON.stringify({ ...summary, steps: result.steps, lineImpedanceOhm: result.lineImpedanceOhm }));
  if (field) {
    result.field = {
      fGHz: args.fieldGHz, i: axisI, yMm: [...board.mesh.y], zMm: [...board.mesh.z], dRefMm: board.grid.dxMm,
      eyRe: [...field.eyRe], eyIm: [...field.eyIm], ezRe: [...field.ezRe], ezIm: [...field.ezIm],
    };
  }
  if (args.out) writeFileSync(args.out, JSON.stringify({ ...summary, ...result }));
}

main();
