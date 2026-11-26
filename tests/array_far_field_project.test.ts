import { beforeAll, describe, expect, it } from 'vitest';
import { solvedFarField, solveProjectText, type ProjectSolve } from '../scripts/noburf';
import { parseProject, type Project } from '../src/project/schema';
import { sectionProject } from '../src/import/section';
import * as actions from '../src/workbench/doc_actions';
import { solveRelevantText } from '../src/workbench/store';
import { dipolePairJson } from './project_fixtures';
import { directivityAt } from './far_field_helpers';

/**
 * The array far field through the project file and the noburf solve path:
 * dipolePairJson's two short dipoles 50 mm apart along x, half a wavelength
 * at 3 GHz. tests/array_far_field.test.ts checks the physics on a hand-built
 * model; this checks the wiring: the drives from outputs.array_excitation,
 * one box record per run, and the refusals of the schema.
 */

describe('array far field from a project file', () => {
  let solved: ProjectSolve;
  /** The far field of the same solve with other drives: the drives never change the runs. */
  const withDrives = (arrayExcitation: Project['outputs']['array_excitation']) => {
    const farField = solvedFarField({ ...solved, project: { ...solved.project, outputs: { ...solved.project.outputs, array_excitation: arrayExcitation } } });
    if (farField?.kind !== 'array') throw new Error('expected an array far field');
    return farField.results[0];
  };
  beforeAll(async () => {
    solved = await solveProjectText(JSON.stringify(dipolePairJson([-25, 25])), 'p.json', false);
  }, 300_000);

  it('keeps one box record per run', () => {
    expect(solved.huygensAccumulatorsPerRun).toHaveLength(2);
    expect(solved.runs.every((run) => run.stoppedOnEnergy)).toBe(true);
  });

  it('drives every excited port in phase without array_excitation: the beam is broadside to the pair', () => {
    const farField = solvedFarField(solved);
    if (farField?.kind !== 'array') throw new Error('expected an array far field');
    expect(farField.drivenPorts).toEqual([{ portId: 'd1', amplitude: 1, phaseDeg: 0 }, { portId: 'd2', amplitude: 1, phaseDeg: 0 }]);
    const r = farField.results[0];
    expect(r.peakThetaDeg).toBe(90);
    expect([90, 270]).toContain(r.peakPhiDeg);
    expect(Math.abs(r.efficiency - 1)).toBeLessThan(0.02);
    expect(r.ports.every((port) => port.activeReflection !== null)).toBe(true);
  });

  it('steers the beam along the pair with the ports in antiphase', () => {
    const r = withDrives({ d1: { amplitude: 1, phase_deg: 0 }, d2: { amplitude: 1, phase_deg: 180 } });
    expect(r.peakThetaDeg).toBe(90);
    expect([0, 180]).toContain(r.peakPhiDeg);
  });

  it('gives each element its own embedded pattern, mirrored across the pair', () => {
    // Each run's box record is that run's alone: a record shared across runs would make the second element's pattern the pair's.
    const first = withDrives({ d1: { amplitude: 1, phase_deg: 0 } });
    const second = withDrives({ d2: { amplitude: 1, phase_deg: 0 } });
    expect(first.ports[1].activeReflection).toBeNull();
    let worst = 0;
    for (const phiDeg of [0, 30, 60, 90, 120, 150, 180]) worst = Math.max(worst, Math.abs(directivityAt(first, 90, phiDeg) - directivityAt(second, 90, 180 - phiDeg)));
    // The 2 mm mesh puts the two ports 1 mm off center (24 and 26 mm), so the mirror is close, not exact.
    expect(worst).toBeLessThan(0.2);
    // The passive neighbor bends the element's pattern: at phi 60 and 120 its re-radiated field arrives half a cycle apart.
    expect(Math.abs(directivityAt(first, 90, 60) - directivityAt(first, 90, 120))).toBeGreaterThan(0.5);
  });

  it('changes nothing but the scale when every drive is doubled', () => {
    const one = withDrives({ d1: { amplitude: 1, phase_deg: 0 }, d2: { amplitude: 1, phase_deg: 45 } });
    const two = withDrives({ d1: { amplitude: 2, phase_deg: 0 }, d2: { amplitude: 2, phase_deg: 45 } });
    expect(two.peakGainDbi).toBeCloseTo(one.peakGainDbi, 9);
    expect(two.radiatedPowerW / one.radiatedPowerW).toBeCloseTo(4, 9);
  });
});

describe('array_excitation in the project file', () => {
  const parse = (centersXMm: number[], outputs: Record<string, unknown>, analysis: Record<string, unknown> = {}) => () => {
    const json = dipolePairJson(centersXMm, outputs);
    parseProject({ ...json, analysis: { ...json.analysis, ...analysis } });
  };

  it('is refused without a far field', () => {
    expect(parse([-25, 25], { far_field_ghz: undefined, array_excitation: { d1: { amplitude: 1 } } })).toThrow(/add outputs.far_field_ghz, or remove outputs.array_excitation/);
  });

  it('is refused on a one-port project', () => {
    expect(parse([0], { array_excitation: { d1: { amplitude: 1 } } })).toThrow(/needs two or more ports/);
  });

  it('refuses a drive on a port that is not excited', () => {
    expect(parse([-25, 25], { array_excitation: { d1: { amplitude: 1 }, d2: { amplitude: 1 } } }, { excite: ['d1'] })).toThrow(/port "d2" is not in analysis.excite/);
  });

  it('refuses a set of drives that drives no port', () => {
    expect(parse([-25, 25], { array_excitation: { d1: { amplitude: 0 } } })).toThrow(/drives no port/);
  });

  it('blames analysis.excite, not the drives, for a bad excite list', () => {
    expect(parse([-25, 25], { array_excitation: { d1: { amplitude: 1 } } }, { excite: ['d9'] })).toThrow(/analysis.excite\[0\]: "d9" is not a port id/);
  });

  it('refuses an amplitude too small to compute', () => {
    expect(parse([-25, 25], { array_excitation: { d1: { amplitude: 1e-200 }, d2: { amplitude: 1 } } })).toThrow(/d1.amplitude: is too small to compute/);
  });

  it('refuses an unknown port id', () => {
    expect(parse([-25, 25], { array_excitation: { d3: { amplitude: 1 } } })).toThrow(/"d3" is not a port id/);
  });
});

describe('array_excitation through workbench edits', () => {
  const driven = () => parseProject(dipolePairJson([-25, 0, 25], { array_excitation: { d1: { amplitude: 1, phase_deg: 0 }, d2: { amplitude: 1, phase_deg: 90 }, d3: { amplitude: 2, phase_deg: 180 } } }));

  it('follows a renamed port', () => {
    const doc = actions.renamePort(driven(), 1, 'middle');
    expect(Object.keys(doc.outputs.array_excitation!)).toEqual(['d1', 'middle', 'd3']);
    expect(() => parseProject(doc)).not.toThrow();
  });

  it('drops a removed port\'s drive, and every drive once one port is left', () => {
    let doc = actions.removePort(driven(), 2);
    expect(doc.outputs.array_excitation).toEqual({ d1: { amplitude: 1, phase_deg: 0 }, d2: { amplitude: 1, phase_deg: 90 } });
    expect(() => parseProject(doc)).not.toThrow();
    doc = actions.removePort(doc, 0);
    expect(doc.outputs.array_excitation).toBeUndefined();
    expect(() => parseProject(doc)).not.toThrow();
  });

  it('drops the drive of a port no longer excited, and drives it at 1, 0° once it is excited again', () => {
    let doc = actions.setExcitedPorts(driven(), ['d1', 'd3']);
    expect(Object.keys(doc.outputs.array_excitation!)).toEqual(['d1', 'd3']);
    expect(() => parseProject(doc)).not.toThrow();
    const keptDrives = structuredClone(doc.outputs.array_excitation!);
    doc = actions.setExcitedPorts(doc, undefined);
    expect(doc.analysis.excite).toBeUndefined();
    expect(doc.outputs.array_excitation).toEqual({ ...keptDrives, d2: { amplitude: 1, phase_deg: 0 } });
    expect(() => parseProject(doc)).not.toThrow();
  });

  it('drops every drive once no kept port is driven', () => {
    const json = dipolePairJson([-25, 0, 25], { array_excitation: { d1: { amplitude: 0 }, d2: { amplitude: 1 }, d3: { amplitude: 1 } } });
    const doc = actions.setExcitedPorts(parseProject(json), ['d1']);
    expect(doc.outputs.array_excitation).toBeUndefined();
    expect(() => parseProject(doc)).not.toThrow();
  });

  it('keeps the drives of the ports a section keeps', () => {
    const halfway = { x0: -34, y0: -6, x1: 12, y1: 6 };
    const { doc } = sectionProject(driven(), halfway);
    expect(doc.ports.map((port) => port.id)).toEqual(['d1', 'd2']);
    expect(doc.outputs.array_excitation).toEqual({ d1: { amplitude: 1, phase_deg: 0 }, d2: { amplitude: 1, phase_deg: 90 } });
    expect(() => parseProject(doc)).not.toThrow();
    const oneLeft = sectionProject(driven(), { ...halfway, x1: -12 }).doc;
    expect(oneLeft.outputs.array_excitation).toBeUndefined();
    expect(() => parseProject(oneLeft)).not.toThrow();
  });

  it('clears the drives with the far field', () => {
    const doc = actions.clearFarField(driven());
    expect(doc.outputs.far_field_ghz).toBeUndefined();
    expect(doc.outputs.array_excitation).toBeUndefined();
    expect(() => parseProject(doc)).not.toThrow();
  });

  it('sets one port\'s drive, first writing every excited port at 1, 0° when the project has no drives', () => {
    const json = dipolePairJson([-25, 0, 25]);
    const undriven = parseProject({ ...json, analysis: { ...json.analysis, excite: ['d1', 'd3'] } });
    const doc = actions.setPortDrive(undriven, 'd3', 'phase_deg', 180);
    expect(doc.outputs.array_excitation).toEqual({ d1: { amplitude: 1, phase_deg: 0 }, d3: { amplitude: 1, phase_deg: 180 } });
    expect(() => parseProject(doc)).not.toThrow();
  });

  it('keeps a port the drives leave out off when only its phase is set', () => {
    const doc = actions.setPortDrive(parseProject(dipolePairJson([-25, 25], { array_excitation: { d1: { amplitude: 1 } } })), 'd2', 'phase_deg', 90);
    expect(doc.outputs.array_excitation).toEqual({ d1: { amplitude: 1, phase_deg: 0 }, d2: { amplitude: 0, phase_deg: 90 } });
    expect(() => parseProject(doc)).not.toThrow();
  });

  it('writes a value that is not a number as given, for the schema to report at its path', () => {
    const doc = actions.setPortDrive(driven(), 'd2', 'amplitude', 'two');
    expect(doc.outputs.array_excitation!.d2).toEqual({ amplitude: 'two', phase_deg: 90 });
    expect(() => parseProject(doc)).toThrow(/\$\.outputs\.array_excitation\.d2\.amplitude/);
  });

  it('leaves the solve current: the drives only weight the runs', () => {
    const doc = actions.setPortDrive(driven(), 'd2', 'phase_deg', 270);
    expect(solveRelevantText(doc)).toBe(solveRelevantText(driven()));
    expect(solveRelevantText(actions.setExcitedPorts(driven(), ['d1', 'd2']))).not.toBe(solveRelevantText(driven()));
  });
});
