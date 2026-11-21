import { applyProjectEdit } from '../project/edits';
import { resolveProject } from '../project/resolve';
import { parseProject, type Project } from '../project/schema';
import type { DesignGoal } from './goal';

/** A switchable feature: shapes in the template project, and the variables that size them. */
export interface Feature {
  /** One line for the strategist: what it is and what it is for. */
  what: string;
  shapes: string[];
  variables: string[];
}

export type FeatureMap = Record<string, Feature>;

/**
 * A design file: a project (the template, with every feature's shapes), the
 * goal, the switchable features, which are on, and the coarser mesh the
 * optimiser searches on. The project's own mesh is the confirm mesh.
 */
export interface DesignFile {
  noburf_design: 1;
  goal: DesignGoal;
  features: FeatureMap;
  enabled: string[];
  search: { mesh: Project['mesh']; energy_decay_db: number };
  project: Project;
}

/** A point in design space: the features that are on, and lengths in mm for any unlocked variables. */
export interface DesignPoint {
  enabled: string[];
  values: Record<string, number>;
}

export type Fidelity = 'search' | 'confirm';

export function parseDesignFile(json: unknown): DesignFile {
  const d = json as DesignFile;
  if (!d || typeof d !== 'object' || d.noburf_design !== 1) throw new Error('not a design file: noburf_design must be 1');
  const project = parseProject(d.project);
  const goal = d.goal as Partial<DesignGoal> | undefined;
  if (!goal || !(typeof goal.target_ghz === 'number' && goal.target_ghz > 0)) throw new Error('goal.target_ghz must be a positive number');
  const fullGoal: DesignGoal = { s11_max_db: -10, f_tolerance_pct: 1, ...goal, target_ghz: goal.target_ghz };
  const shapeIds = new Set(Object.values(project.geometry).flat().map((s) => s.id));
  for (const [name, f] of Object.entries(d.features ?? {})) {
    for (const id of f.shapes) if (!shapeIds.has(id)) throw new Error(`feature "${name}": no shape "${id}" in the project`);
    for (const v of f.variables) if (!Object.hasOwn(project.variables, v)) throw new Error(`feature "${name}": no variable "${v}" in the project`);
  }
  for (const name of d.enabled ?? []) if (!Object.hasOwn(d.features, name)) throw new Error(`enabled: no feature "${name}"`);
  if (!d.search?.mesh || !(d.search.energy_decay_db > 0)) throw new Error('search needs a mesh and energy_decay_db');
  // The search mesh must itself be valid: parse the project with it.
  parseProject({ ...project, mesh: d.search.mesh });
  return { noburf_design: 1, goal: fullGoal, features: d.features ?? {}, enabled: d.enabled ?? [], search: d.search, project };
}

/** Variables that are lengths and not locked: the ones a design may change. */
export function tunableVariables(project: Project): string[] {
  const resolved = resolveProject(project).variables;
  return Object.entries(project.variables).filter(([n, v]) => !v.locked && resolved[n].dim === 1).map(([n]) => n);
}

/** Tunable variables missing a min or a max: variableBounds would assume 0 or 4 times the value for them. */
export function unboundedVariables(project: Project): string[] {
  return tunableVariables(project).filter((n) => project.variables[n].min === undefined || project.variables[n].max === undefined);
}

/** Whether `expr` names variable `name` as a whole word. */
const names = (expr: string, name: string) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(expr);

/**
 * A design file around a project built elsewhere (the workbench, an import),
 * with no switchable features: the tuner may change exactly the project's
 * unlocked length variables, within their own min and max. It refuses what it
 * would otherwise have to guess or would tune by accident: a variable without
 * both limits; one computed from other variables (the tuner would overwrite
 * the expression with a number); one that sizes the mesh, the stackup or the
 * board outline (the search would change the board, not the design); one
 * nothing uses (solves spent on nothing); more than one port; a target
 * outside the band; and an axial-ratio goal without a far field at the target.
 * The search runs on the project's own mesh with a shallower energy stop: a
 * coarser mesh would round each dielectric to a different number of cells and
 * so search a different board than the confirm solve.
 */
export function tuningDesignFromProject(project: Project, goal: DesignGoal): DesignFile {
  if (project.ports.length !== 1) throw new Error(`the tuner reads one port's S11; this project has ${project.ports.length} ports`);
  const free = tunableVariables(project);
  if (!free.length) throw new Error('nothing to tune: every length variable is locked (or the project has none). Unlock one and give it a min and max.');
  const list = (vars: string[]) => vars.map((n) => `"${n}"`).join(', ');
  const them = (vars: string[]) => (vars.length > 1 ? 'them' : 'it');
  const open = unboundedVariables(project);
  if (open.length) throw new Error(`set a min and a max on ${list(open)}, or lock ${them(open)}: the tuner only changes a variable within limits you set`);
  const derived = free.filter((n) => Object.keys(project.variables).some((other) => other !== n && names(project.variables[n].value, other)));
  if (derived.length) throw new Error(`${list(derived)} ${derived.length > 1 ? 'are' : 'is'} computed from other variables; lock ${them(derived)} so ${derived.length > 1 ? 'they follow' : 'it follows'} them, or give ${them(derived)} a plain length to tune`);
  const structural = JSON.stringify([project.mesh, project.stackup, project.board]);
  const sizesBoard = free.filter((n) => names(structural, n));
  if (sizesBoard.length) throw new Error(`${list(sizesBoard)} ${sizesBoard.length > 1 ? 'set' : 'sets'} the mesh, the stackup or the board outline; lock ${them(sizesBoard)}: the tuner changes the design on a fixed board`);
  const unused = free.filter((n) => {
    const rest = { ...project, variables: Object.fromEntries(Object.entries(project.variables).filter(([k]) => k !== n)) };
    return !names(JSON.stringify(rest), n);
  });
  if (unused.length) throw new Error(`nothing uses ${list(unused)}; lock or delete ${them(unused)}, or the tuner spends solves on ${them(unused)}`);
  const { f_min_ghz: lo, f_max_ghz: hi } = project.analysis;
  if (goal.target_ghz < lo || goal.target_ghz > hi) throw new Error(`target ${goal.target_ghz} GHz is outside the project's band ${lo} to ${hi} GHz`);
  if (goal.max_axial_ratio_db !== undefined && !project.outputs.far_field_ghz?.length) throw new Error('an axial-ratio goal needs outputs.far_field_ghz at the target in the project');
  const energy = Math.min(SEARCH_ENERGY_DECAY_DB, project.analysis.stop.energy_decay_db);
  return { ...designFromProject(project, goal.target_ghz), goal, search: { mesh: project.mesh, energy_decay_db: energy } };
}

/** The search's energy stop: shallower than a confirm solve's usual 50 dB, as the patch template's search. */
const SEARCH_ENERGY_DECAY_DB = 30;

/** Current resolved value of every tunable variable, in mm. */
export function currentValues(project: Project): Record<string, number> {
  const resolved = resolveProject(project).variables;
  return Object.fromEntries(tunableVariables(project).map((n) => [n, resolved[n].value]));
}

/** A variable's bounds in mm, evaluated with the other variables at their values in `project`. */
export function variableBounds(project: Project, name: string): { min: number; max: number } {
  const def = project.variables[name];
  const resolved = resolveProject(project).variables;
  const evalBound = (expr: string | undefined, fallback: number) => {
    if (expr === undefined) return fallback;
    // Resolve the bound by temporarily making it a variable of its own.
    const probe = structuredClone(project);
    probe.variables.__bound = { value: expr };
    return resolveProject(probe).variables.__bound.value;
  };
  return { min: evalBound(def.min, 0), max: evalBound(def.max, Math.max(resolved[name].value * 4, 1)) };
}

/**
 * The project for a design point: switched-off features' shapes removed, the
 * values set (each edit checked against ranges and locks), and the mesh and
 * energy stop of the fidelity. Throws a ProjectError naming the problem when
 * the point is outside a range.
 */
/** The variables of the switched-off features: their ranges do not apply while off. */
function offVariables(design: DesignFile, enabled: string[]): Set<string> {
  return new Set(Object.entries(design.features).filter(([name]) => !enabled.includes(name)).flatMap(([, f]) => f.variables));
}

/** The project with the off features' ranges removed: they would fence in the base variables they name. */
function withoutOffRanges(design: DesignFile, project: Project, enabled: string[]): Project {
  const doc = structuredClone(project);
  for (const v of offVariables(design, enabled)) {
    delete doc.variables[v].min;
    delete doc.variables[v].max;
  }
  return doc;
}

/** Where a design file starts: its enabled features and the values in its project. */
export function startPoint(design: DesignFile): DesignPoint {
  return { enabled: [...design.enabled], values: currentValues(withoutOffRanges(design, design.project, design.enabled)) };
}

/**
 * The design file at a point, to continue from: every shape kept, the values
 * of the base variables and the switched-on features written in. An off
 * feature's value stays as it was unless a range that depends on a base
 * variable that moved now excludes it (a stub position past a shorter patch);
 * then it is moved to the nearest bound, so the file is valid as a whole.
 */
export function designAt(design: DesignFile, point: DesignPoint): DesignFile {
  const off = offVariables(design, point.enabled);
  let project = withoutOffRanges(design, design.project, point.enabled);
  for (const [name, value] of Object.entries(point.values)) if (!off.has(name)) project.variables[name].value = `${Number(value.toFixed(4))} mm`;
  // Give each off variable its range back, one at a time, clamping its value into it.
  for (const name of off) {
    const { min, max } = design.project.variables[name];
    const probe = structuredClone(project);
    if (min !== undefined) probe.variables.__min = { value: min };
    if (max !== undefined) probe.variables.__max = { value: max };
    const r = resolveProject(probe).variables;
    const lo = r.__min?.value ?? -Infinity;
    const hi = r.__max?.value ?? Infinity;
    const value = r[name].value;
    project = structuredClone(project);
    const def = project.variables[name];
    if (value < lo || value > hi) def.value = `${Number(Math.min(Math.max(value, lo), hi).toFixed(4))} mm`;
    if (min !== undefined) def.min = min;
    if (max !== undefined) def.max = max;
  }
  return { ...design, enabled: [...point.enabled], project: parseProject(project) };
}

export function projectFor(design: DesignFile, point: DesignPoint, fidelity: Fidelity): Project {
  let project = design.project;
  for (const [name, feature] of Object.entries(design.features)) {
    if (point.enabled.includes(name)) continue;
    for (const id of feature.shapes) project = applyProjectEdit(project, { op: 'remove_polygon', id }).project;
  }
  // All values at once: one at a time could pass through a state outside a range that depends on another value.
  const doc = withoutOffRanges(design, project, point.enabled);
  for (const [name, value] of Object.entries(point.values)) {
    const def = Object.hasOwn(doc.variables, name) ? doc.variables[name] : undefined;
    if (!def) throw new Error(`no variable "${name}"`);
    if (def.locked) throw new Error(`variable "${name}" is locked`);
    def.value = `${Number(value.toFixed(4))} mm`;
  }
  if (fidelity === 'search') {
    doc.mesh = design.search.mesh;
    doc.analysis.stop = { ...doc.analysis.stop, energy_decay_db: design.search.energy_decay_db };
  }
  const edited = parseProject(doc);
  resolveProject(edited); // checks every range
  return edited;
}

/**
 * A plain project as a design file: no features, the goal at `targetGhz`
 * (default: the first Z_in frequency, else mid-band), and `searchMesh` as
 * the search fidelity (default the project's own mesh), so a sensitivity
 * study can run on any project.
 */
export function designFromProject(json: unknown, targetGhz?: number, searchMesh?: Project['mesh']): DesignFile {
  const project = parseProject(json);
  const a = project.analysis;
  const target = targetGhz ?? project.outputs.zin_at_ghz?.[0] ?? (a.f_min_ghz + a.f_max_ghz) / 2;
  return parseDesignFile({
    noburf_design: 1,
    goal: { target_ghz: target },
    features: {},
    enabled: [],
    search: { mesh: searchMesh ?? project.mesh, energy_decay_db: a.stop.energy_decay_db },
    project,
  });
}
