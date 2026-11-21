import type { ConductorMaterial, DielectricMaterial } from '../project/schema';

/**
 * Materials an RF engineer reaches for, to copy into a project with one
 * click. The project file keeps its own copy, so a file never depends on this
 * list. FR-4, RO4003C, air, copper and PEC are built into the project format
 * (BUILTIN_MATERIALS) and are not repeated here.
 *
 * Laminates: the manufacturer's "design Dk" (the value it recommends for
 * circuit simulation, from its microstrip or stripline measurements) and Df
 * at 10 GHz, from the current datasheets. Ceramics and films: typical
 * values; check the supplier's sheet, which varies with purity and grade.
 * Metals: DC conductivity at 20 °C, as in common EM tool libraries.
 */
export interface LibraryDielectric extends DielectricMaterial {
  name: string;
  group: 'Laminates' | 'Ceramics and films';
  source: string;
}

export interface LibraryConductor extends ConductorMaterial {
  name: string;
  group: 'Metals';
  source: string;
}

export type LibraryMaterial = LibraryDielectric | LibraryConductor;

const rogers = (name: string, eps_r: number, tan_delta: number): LibraryDielectric =>
  ({ name, group: 'Laminates', eps_r, tan_delta, source: 'Rogers datasheet, design Dk and Df at 10 GHz' });
const taconic = (name: string, eps_r: number, tan_delta: number, atGHz: number): LibraryDielectric =>
  ({ name, group: 'Laminates', eps_r, tan_delta, source: `AGC (Taconic) datasheet, Dk and Df at ${atGHz} GHz` });
const typical = (name: string, eps_r: number, tan_delta: number, note: string): LibraryDielectric =>
  ({ name, group: 'Ceramics and films', eps_r, tan_delta, source: `Typical, ${note}` });
const metal = (name: string, conductivity_s_per_m: number, source = 'Bulk conductivity at 20 °C'): LibraryConductor =>
  ({ name, group: 'Metals', conductivity_s_per_m, source });

export const MATERIAL_LIBRARY: readonly LibraryMaterial[] = [
  {
    name: 'FR-4 wideband', group: 'Laminates', eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'djordjevic_sarkar', at_ghz: 1 },
    source: 'Typical FR-4 at 1 GHz with the Djordjevic-Sarkar wideband model (IEEE Trans. EMC 43(4), 2001): εr falls about 3 % per decade, loss stays flat',
  },
  rogers('RO4350B', 3.66, 0.0037),
  rogers('RO4835', 3.66, 0.0037),
  rogers('RO4360G2', 6.4, 0.0038),
  rogers('RO3003', 3.0, 0.001),
  rogers('RO3006', 6.5, 0.002),
  rogers('RO3010', 11.2, 0.0022),
  rogers('RT/duroid 5880', 2.2, 0.0009),
  rogers('RT/duroid 5870', 2.33, 0.0012),
  rogers('RT/duroid 6002', 2.94, 0.0012),
  rogers('RT/duroid 6010.2LM', 10.7, 0.0023),
  taconic('TLY-5', 2.2, 0.0009, 10),
  taconic('RF-35', 3.5, 0.0018, 1.9),
  typical('PTFE', 2.1, 0.0002, 'unfilled bulk PTFE'),
  typical('Polyimide', 3.4, 0.003, 'flex film such as Kapton'),
  typical('Alumina 96%', 9.4, 0.0003, '96 % Al2O3 thick-film substrate'),
  typical('Alumina 99.6%', 9.9, 0.0001, '99.6 % Al2O3 thin-film substrate'),
  typical('Fused silica', 3.82, 0.0001, 'quartz substrate'),
  metal('silver', 6.3e7),
  metal('gold', 4.1e7),
  metal('aluminium', 3.8e7),
  metal('brass', 1.5e7),
  metal('tin', 8.67e6),
  metal('stainless steel', 1.1e6, 'The value EM tools commonly use; bulk 304 is about 1.4e6 S/m'),
];

export const isConductor = (m: LibraryMaterial): m is LibraryConductor => m.group === 'Metals';

export function libraryMaterial(name: string): LibraryMaterial | undefined {
  return MATERIAL_LIBRARY.find((m) => m.name === name);
}

/** The project-file form of a library entry: just the numbers. */
export function projectMaterial(m: LibraryMaterial): DielectricMaterial | ConductorMaterial {
  if (isConductor(m)) return { conductivity_s_per_m: m.conductivity_s_per_m };
  const { name: _name, group: _group, source: _source, ...material } = m;
  return structuredClone(material);
}
