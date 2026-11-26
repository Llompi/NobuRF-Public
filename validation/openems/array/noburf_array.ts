/**
 * NobuRF's side of the array cross-check (README.md): one CPU solve of a
 * project file, then its far field for each drive set, written to
 * results/<name>_noburf.json.
 *
 *   node --import tsx --import ./src/node/register_raw_imports.mjs validation/openems/array/noburf_array.ts validation/openems/array/dipole_pair.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { solvedFarField, solveProjectText } from '../../../scripts/noburf';

const DRIVE_SETS = { in_phase: [0, 0], antiphase: [0, 180] } as const;

const projectPath = process.argv[2];
if (!projectPath) throw new Error('usage: noburf_array.ts <project.json>');
const solved = await solveProjectText(readFileSync(projectPath, 'utf8'), projectPath, false);
const portIds = solved.project.ports.map((port) => port.id);
if (portIds.length !== 2) throw new Error(`${projectPath} has ${portIds.length} ports; the cross-check drives two`);

const results = Object.entries(DRIVE_SETS).map(([driveSetName, phasesDeg]) => {
  const arrayExcitation = Object.fromEntries(portIds.map((id, k) => [id, { amplitude: 1, phase_deg: phasesDeg[k] }]));
  const farField = solvedFarField({ ...solved, project: { ...solved.project, outputs: { ...solved.project.outputs, array_excitation: arrayExcitation } } });
  if (farField?.kind !== 'array') throw new Error('expected an array far field');
  const result = farField.results[0];
  return {
    drive_set: driveSetName,
    phases_deg: phasesDeg,
    frequency_ghz: result.frequencyHz / 1e9,
    peak_directivity_dbi: result.peakDirectivityDbi,
    peak_theta_deg: result.peakThetaDeg,
    peak_phi_deg: result.peakPhiDeg,
    radiation_efficiency: result.efficiency,
    active_reflection: result.ports.map((port, k) => ({ port: portIds[k], re: port.activeReflection![0], im: port.activeReflection![1] })),
    theta_deg: Array.from(result.thetaDeg),
    phi_deg: Array.from(result.phiDeg),
    directivity_dbi: Array.from(result.directivityDbi),
  };
});

const outputDirectory = join(dirname(projectPath), 'results');
mkdirSync(outputDirectory, { recursive: true });
const outputPath = join(outputDirectory, `${basename(projectPath, '.json')}_noburf.json`);
writeFileSync(outputPath, JSON.stringify({ solver: 'NobuRF (CPU)', project: solved.project.name, energy_decay_db: solved.runs.map((run) => run.energyDecayDb), results }, null, 1) + '\n');
console.log(`wrote ${outputPath}`);
