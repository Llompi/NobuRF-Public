import { evaluate, evaluateLength, ExpressionError, type Quantity } from './expression';
import type { PortDrive } from '../engine/array_far_field';
import type { ComponentValues } from '../engine/lumped';
import type { Roughness } from '../engine/surface_impedance';
import { materialResponses, type MaterialResponses } from './materials';
import { BUILTIN_MATERIALS, fail, type ArrayPortDrive, type BuiltinMaterial, type Boundary, type Face, type Point, type Project, type RoughnessDef, type SmaEdgePort } from './schema';

export type Vec2 = [x: number, y: number];

/** 1 oz copper, the most common PCB weight. */
export const DEFAULT_COPPER_THICKNESS_MM = 0.035;

export type ResolvedLayer =
  /** conductivity null: PEC. thicknessMm only sets the edge loss (edgeLossFactor). */
  | { type: 'copper'; name: string; conductivitySPerM: number | null; thicknessMm: number; roughness: Roughness | null }
  | {
    type: 'dielectric'; name: string; epsR: number; tanDelta: number; thicknessMm: number; path: string;
    /** Frequency-dependent and magnetic parts (materials.ts); null where the plain eps_r, tan_delta path applies. Shared by layers of one material. */
    responses: MaterialResponses;
    /** Where the material is defined, for errors about it. */
    materialPath: string;
  };

export interface ResolvedShape {
  id: string;
  op: 'add' | 'cut';
  polygon: Vec2[];
}

export interface ResolvedPort {
  kind: 'lumped' | 'sma_edge' | 'coax_probe';
  id: string;
  /** For an SMA edge port, the pin's point on the board edge: the edge's coordinate is the board's extent there. */
  xMm: number;
  yMm: number;
  /** The board edge of an SMA edge port, else null. */
  edge: SmaEdgePort['edge'] | null;
  between: [string, string];
  z0: number;
  /** Feed length to de-embed (mm), lumped ports only; null: none. */
  deembedMm: number | null;
}

/** A lumped component with its value in SI units and its place in mm. */
export interface ResolvedComponent {
  id: string;
  values: ComponentValues;
  place:
    | { kind: 'between'; xMm: number; yMm: number; between: [string, string] }
    /** axis: 0 when the part runs along x, 1 along y; fromMm < toMm along it; acrossMm is the other coordinate. */
    | { kind: 'layer'; layer: string; axis: 0 | 1; fromMm: number; toMm: number; acrossMm: number; widthMm: number | null };
}

/**
 * A project with every expression evaluated (lengths in mm) and every
 * cross-reference checked. Derived data: never stored, always recomputed
 * from the document.
 */
export interface ResolvedProject {
  variables: Record<string, Quantity>;
  /** Bottom to top. */
  stackup: ResolvedLayer[];
  boardOutline: Vec2[];
  copper: Record<string, ResolvedShape[]>;
  /** In project order; VoxelModel.ports follows the same order. */
  ports: ResolvedPort[];
  /** In project order; empty when the project has none. */
  components: ResolvedComponent[];
  /** Every via, a fence expanded into its vias, in project order; empty when the project has none. */
  vias: ResolvedVia[];
  /** Indices into `ports` of the ports to excite (analysis.excite, default all), in project order. */
  excite: number[];
  boundaries: Record<Face, Boundary>;
  cellMm: number;
  airMarginCells: Project['mesh']['air_margin_cells'];
  /** Graded mesh settings in mm, or null for uniform cubic cells. */
  graded: { edgeCellMm: number; dielectricCells: number; maxGrowth: number } | null;
  /** Copper edges by covered fraction (conformal.ts) instead of a staircase. */
  conformal: boolean;
}

export interface ResolvedVia {
  /** The project id; a fence's vias add their index, "fence#3". */
  id: string;
  /** JSON path of the via or fence, for errors. */
  path: string;
  /** Index of the via or fence in the project's vias. */
  index: number;
  xMm: number;
  yMm: number;
  radiusMm: number;
  /** Half the antipad, or null without one. */
  antipadRadiusMm: number | null;
  /** Part of a fence (to and pitch), whose vias get no rim mesh lines. */
  inFence: boolean;
  /** The two copper layers it joins, bottom first (stackup order). */
  between: [string, string];
}

/** Most vias one fence may hold: a typo in pitch would otherwise make millions. */
export const MAX_VIAS_PER_FENCE = 2000;

/** Sides of the polygon an antipad is cut as; it circumscribes the clearance circle. */
const ANTIPAD_SIDES = 32;

/** Run `body`, turning an ExpressionError into a ProjectError at `path`. */
function atPath<T>(path: string, body: () => T): T {
  try {
    return body();
  } catch (e) {
    if (e instanceof ExpressionError) fail(path, e.message);
    throw e;
  }
}

function polygonArea(points: Vec2[]): number {
  let twiceArea = 0;
  for (let n = 0; n < points.length; n++) {
    const [x0, y0] = points[n];
    const [x1, y1] = points[(n + 1) % points.length];
    twiceArea += x0 * y1 - x1 * y0;
  }
  return twiceArea / 2;
}

export function resolveProject(p: Project): ResolvedProject {
  const values = new Map<string, Quantity>();
  const variable = (name: string, chain: readonly string[]): Quantity => {
    const known = values.get(name);
    if (known) return known;
    if (!Object.hasOwn(p.variables, name)) throw new ExpressionError(`unknown variable "${name}"`);
    const def = p.variables[name];
    if (chain.includes(name)) throw new ExpressionError(`variables depend on each other in a cycle: ${[...chain, name].join(' -> ')}`);
    const lookup = (n: string) => variable(n, [...chain, name]);
    const q = atPath(`$.variables.${name}.value`, () => evaluate(def.value, lookup));
    for (const bound of ['min', 'max'] as const) {
      const expr = def[bound];
      if (expr === undefined) continue;
      const path = `$.variables.${name}.${bound}`;
      const limit = atPath(path, () => evaluate(expr, lookup));
      if (limit.dim !== q.dim) fail(path, `"${expr}" and value "${def.value}" have different units`);
      if (bound === 'min' ? q.value < limit.value : q.value > limit.value) {
        fail(`$.variables.${name}.value`, `"${def.value}" is ${bound === 'min' ? 'below' : 'above'} its ${bound} "${expr}"`);
      }
    }
    values.set(name, q);
    return q;
  };
  for (const name of Object.keys(p.variables)) variable(name, []);
  const lookup = (name: string) => variable(name, []);
  const length = (expr: string, path: string) => atPath(path, () => evaluateLength(expr, lookup));
  const positiveLength = (expr: string, path: string) => {
    const mm = length(expr, path);
    if (!(mm > 0)) fail(path, `"${expr}" must be positive, got ${mm} mm`);
    return mm;
  };
  const polygon = (points: Point[], path: string): Vec2[] => {
    const resolved = points.map(([x, y], n): Vec2 => [length(x, `${path}[${n}][0]`), length(y, `${path}[${n}][1]`)]);
    if (Math.abs(polygonArea(resolved)) < 1e-12) fail(path, 'polygon has zero area');
    return resolved;
  };

  const material = (name: string): BuiltinMaterial | undefined => {
    if (Object.hasOwn(BUILTIN_MATERIALS, name)) return BUILTIN_MATERIALS[name];
    if (!Object.hasOwn(p.materials, name)) return undefined;
    const m = p.materials[name];
    return 'conductivity_s_per_m' in m ? { kind: 'conductor', ...m } : { kind: 'dielectric', ...m };
  };
  const layerNames = new Set<string>();
  const band = { fMinHz: p.analysis.f_min_ghz * 1e9, fMaxHz: p.analysis.f_max_ghz * 1e9, lossReferenceHz: p.analysis.loss_reference_ghz * 1e9 };
  const responsesByMaterial = new Map<string, MaterialResponses>();
  const stackup = p.stackup.map((layer, n): ResolvedLayer => {
    const path = `$.stackup[${n}]`;
    if (layerNames.has(layer.name)) fail(`${path}.name`, `duplicate layer name "${layer.name}"`);
    layerNames.add(layer.name);
    const m = material(layer.material);
    if (!m) fail(`${path}.material`, `unknown material "${layer.material}"`);
    if (layer.type === 'copper') {
      if (m.kind === 'dielectric') fail(`${path}.material`, `copper layer needs a conductor; "${layer.material}" is a dielectric`);
      if (p.stackup[n - 1]?.type === 'copper') fail(path, `two copper layers with nothing between them ("${p.stackup[n - 1].name}", "${layer.name}")`);
      const thicknessMm = layer.thickness === undefined ? DEFAULT_COPPER_THICKNESS_MM : positiveLength(layer.thickness, `${path}.thickness`);
      const conductor = m.kind === 'conductor' ? m : null;
      return { type: 'copper', name: layer.name, conductivitySPerM: conductor?.conductivity_s_per_m ?? null, thicknessMm, roughness: conductor?.roughness ? toRoughness(conductor.roughness) : null };
    }
    if (m.kind !== 'dielectric') fail(`${path}.material`, `dielectric layer needs a dielectric; "${layer.material}" is a conductor`);
    const thicknessMm = positiveLength(layer.thickness, `${path}.thickness`);
    const materialPath = Object.hasOwn(p.materials, layer.material) ? `$.materials.${layer.material}` : `${path}.material`;
    // One response object per material: layers of one material are the same medium to rasterise (interfaces, pole sets).
    let responses = responsesByMaterial.get(layer.material);
    if (!responses) {
      try {
        responses = materialResponses(m, band);
      } catch (e) {
        fail(materialPath, (e as Error).message);
      }
      responsesByMaterial.set(layer.material, responses);
    }
    return { type: 'dielectric', name: layer.name, epsR: m.eps_r, tanDelta: m.tan_delta, thicknessMm, path: `${path}.thickness`, materialPath, responses };
  });
  if (!stackup.some((l) => l.type === 'dielectric')) fail('$.stackup', 'needs at least one dielectric layer');
  const copperNames = stackup.filter((l) => l.type === 'copper').map((l) => l.name);

  const copper: Record<string, ResolvedShape[]> = {};
  const shapeIds = new Set<string>();
  for (const [layer, shapes] of Object.entries(p.geometry)) {
    if (!copperNames.includes(layer)) fail(`$.geometry.${layer}`, `"${layer}" is not a copper layer of the stackup (copper layers: ${copperNames.join(', ')})`);
    copper[layer] = shapes.map((s, n) => {
      const path = `$.geometry.${layer}[${n}]`;
      if (shapeIds.has(s.id)) fail(`${path}.id`, `duplicate shape id "${s.id}"`);
      shapeIds.add(s.id);
      return { id: s.id, op: s.op, polygon: polygon(s.polygon, `${path}.polygon`) };
    });
  }
  for (const name of copperNames) if (!Object.hasOwn(copper, name)) fail('$.geometry', `copper layer "${name}" has no entry (use [] for a bare layer)`);

  if (p.ports.length === 0) fail('$.ports', 'needs at least one port');
  const boardOutline = polygon(p.board.outline, '$.board.outline');
  const portIds = p.ports.map((port) => port.id);
  const ports = p.ports.map((port, n): ResolvedPort => {
    const path = `$.ports[${n}]`;
    if (portIds.indexOf(port.id) !== n) fail(`${path}.id`, `duplicate port id "${port.id}"`);
    for (const [m, layer] of port.between.entries()) {
      if (!copperNames.includes(layer)) fail(`${path}.between[${m}]`, `"${layer}" is not a copper layer (copper layers: ${copperNames.join(', ')})`);
    }
    if (port.between[0] === port.between[1]) fail(`${path}.between`, 'a port spans two different copper layers');
    const deembedMm = port.kind === undefined || port.kind === 'lumped' ? port.deembed && length(port.deembed.length, `${path}.deembed.length`) : undefined;
    if (deembedMm !== undefined && !(deembedMm > 0)) fail(`${path}.deembed.length`, `must be positive, got ${deembedMm} mm`);
    const common = { kind: port.kind ?? 'lumped', id: port.id, between: port.between, z0: port.reference_impedance_ohm, deembedMm: deembedMm ?? null } as const;
    if (port.kind !== 'sma_edge') return { ...common, xMm: length(port.x, `${path}.x`), yMm: length(port.y, `${path}.y`), edge: null };
    const extent = (axis: 0 | 1) => (port.edge.endsWith('min') ? Math.min : Math.max)(...boardOutline.map((q) => q[axis]));
    return port.edge[0] === 'y'
      ? { ...common, xMm: length(port.x!, `${path}.x`), yMm: extent(1), edge: port.edge }
      : { ...common, xMm: extent(0), yMm: length(port.y!, `${path}.y`), edge: port.edge };
  });
  const takenIds = new Set(portIds);
  const components = (p.components ?? []).map((c, n): ResolvedComponent => {
    const path = `$.components[${n}]`;
    if (takenIds.has(c.id)) fail(`${path}.id`, `id "${c.id}" is already used by a port or another component`);
    takenIds.add(c.id);
    const layer = (name: string, at: string) => {
      if (!copperNames.includes(name)) fail(at, `"${name}" is not a copper layer (copper layers: ${copperNames.join(', ')})`);
      return name;
    };
    const values: ComponentValues = {
      resistanceOhm: c.r_ohm ?? null,
      inductanceH: c.l_nh === undefined ? null : c.l_nh * 1e-9,
      capacitanceF: c.c_pf === undefined ? null : c.c_pf * 1e-12,
      connection: c.connection ?? 'series',
    };
    if ('between' in c) {
      c.between.forEach((name, m) => layer(name, `${path}.between[${m}]`));
      if (c.between[0] === c.between[1]) fail(`${path}.between`, 'a component spans two different copper layers');
      return { id: c.id, values, place: { kind: 'between', xMm: length(c.x, `${path}.x`), yMm: length(c.y, `${path}.y`), between: c.between } };
    }
    const [from, to] = [c.from, c.to].map((q, m) => q.map((v, axis) => length(v, `${path}.${m === 0 ? 'from' : 'to'}[${axis}]`)));
    const moves = [0, 1].filter((axis) => Math.abs(to[axis] - from[axis]) > 1e-9);
    if (moves.length !== 1) fail(path, 'from and to must differ along exactly one of x and y: a component runs along an axis');
    const axis = moves[0] as 0 | 1;
    return {
      id: c.id,
      values,
      place: {
        kind: 'layer',
        layer: layer(c.layer, `${path}.layer`),
        axis,
        fromMm: Math.min(from[axis], to[axis]),
        toMm: Math.max(from[axis], to[axis]),
        acrossMm: from[1 - axis],
        widthMm: c.width === undefined ? null : positiveLength(c.width, `${path}.width`),
      },
    };
  });
  const vias: ResolvedVia[] = [];
  (p.vias ?? []).forEach((v, n) => {
    const path = `$.vias[${n}]`;
    if (takenIds.has(v.id)) fail(`${path}.id`, `id "${v.id}" is already used by a port, a component or another via`);
    takenIds.add(v.id);
    v.between.forEach((name, m) => {
      if (!copperNames.includes(name)) fail(`${path}.between[${m}]`, `"${name}" is not a copper layer (copper layers: ${copperNames.join(', ')})`);
    });
    if (v.between[0] === v.between[1]) fail(`${path}.between`, 'a via joins two different copper layers');
    const between = [...v.between].sort((a, b) => copperNames.indexOf(a) - copperNames.indexOf(b)) as [string, string];
    const radiusMm = positiveLength(v.drill, `${path}.drill`) / 2;
    const [x0, y0] = [length(v.x, `${path}.x`), length(v.y, `${path}.y`)];
    let points: Vec2[] = [[x0, y0]];
    if (v.to !== undefined) {
      const [x1, y1] = v.to.map((q, axis) => length(q, `${path}.to[${axis}]`));
      const pitch = positiveLength(v.pitch!, `${path}.pitch`);
      const span = Math.hypot(x1 - x0, y1 - y0);
      const count = Math.floor(span / pitch + 1e-9) + 1;
      if (count > MAX_VIAS_PER_FENCE) fail(`${path}.pitch`, `${pitch} mm over ${+span.toFixed(4)} mm makes ${count} vias, more than ${MAX_VIAS_PER_FENCE}`);
      if (count < 2) fail(`${path}.to`, `is closer to (x, y) than one pitch (${pitch} mm): the fence would be one via`);
      if (pitch <= 2 * radiusMm) fail(`${path}.pitch`, `${pitch} mm is not more than the drill (${2 * radiusMm} mm): the vias would touch or overlap`);
      points = Array.from({ length: count }, (_, m): Vec2 => [x0 + ((x1 - x0) * m * pitch) / span, y0 + ((y1 - y0) * m * pitch) / span]);
    }
    const clearance = v.antipad === undefined ? null : positiveLength(v.antipad, `${path}.antipad`) / 2;
    points.forEach(([xMm, yMm], m) => vias.push({
      id: v.to === undefined ? v.id : `${v.id}#${m + 1}`, path, index: n, xMm, yMm, radiusMm, antipadRadiusMm: clearance, inFence: v.to !== undefined, between,
    }));
    if (clearance === null) return;
    if (clearance <= radiusMm) fail(`${path}.antipad`, `must be larger than the drill (${2 * radiusMm} mm)`);
    const inner = copperNames.slice(copperNames.indexOf(between[0]) + 1, copperNames.indexOf(between[1]));
    if (inner.length === 0) fail(`${path}.antipad`, `"${between[0]}" and "${between[1]}" have no copper layer between them to clear`);
    // Circumscribed, so the clearance is at least the drawn diameter in every direction.
    const corner = clearance / Math.cos(Math.PI / ANTIPAD_SIDES);
    for (const layer of inner) {
      points.forEach(([cx, cy], m) => copper[layer].push({
        id: `${v.id}${v.to === undefined ? '' : `#${m + 1}`}/antipad`,
        op: 'cut',
        polygon: Array.from({ length: ANTIPAD_SIDES }, (_, q): Vec2 => {
          const angle = (2 * Math.PI * (q + 0.5)) / ANTIPAD_SIDES;
          return [cx + corner * Math.cos(angle), cy + corner * Math.sin(angle)];
        }),
      }));
    }
  });
  if (vias.length > 0 && ports.some((port) => port.kind !== 'lumped')) {
    fail('$.vias', 'vias are not supported yet in a project with an SMA connector or coax probe: the connector repaints the copper around it');
  }
  const exciteIds = excitedPortIds(p);
  if (exciteIds.length === 0) fail('$.analysis.excite', 'names no port; leave it out to excite every port');
  exciteIds.forEach((id, n) => {
    if (!portIds.includes(id)) fail(`$.analysis.excite[${n}]`, `"${id}" is not a port id (ports: ${portIds.join(', ')})`);
    if (exciteIds.indexOf(id) !== n) fail(`$.analysis.excite[${n}]`, `port "${id}" is listed twice`);
  });
  for (const [id, drive] of Object.entries(p.outputs.array_excitation ?? {})) {
    if (drive.amplitude > 0 && !exciteIds.includes(id)) fail(`$.outputs.array_excitation.${id}`, `port "${id}" is not in analysis.excite, so it has no run to drive it with`);
  }
  const excite = portIds.flatMap((id, n) => (exciteIds.includes(id) ? [n] : []));

  return {
    variables: Object.fromEntries(values),
    stackup,
    boardOutline,
    copper,
    ports,
    components,
    vias,
    excite,
    boundaries: p.boundaries,
    cellMm: positiveLength(p.mesh.cell, '$.mesh.cell'),
    airMarginCells: p.mesh.air_margin_cells,
    conformal: p.mesh.conformal === true,
    graded: p.mesh.graded === undefined ? null : {
      edgeCellMm: positiveLength(p.mesh.graded.edge_cell, '$.mesh.graded.edge_cell'),
      dielectricCells: p.mesh.graded.dielectric_cells,
      maxGrowth: p.mesh.graded.max_growth,
    },
  };
}

/** The project file's roughness (micrometres, snake case) as surface_impedance.ts takes it. */
function toRoughness(r: RoughnessDef): Roughness {
  return r.model === 'huray' ? { model: 'huray', radiusUm: r.radius_um, surfaceRatio: r.surface_ratio } : { model: r.model, rmsUm: r.rms_um };
}

/**
 * Dielectric layers that conduct at DC: a plain loss tangent (a constant
 * conductivity, exact at analysis.loss_reference_ghz), or a pole model whose
 * poles leave part of the loss to a constant conductivity. A real laminate
 * barely conducts at DC. Frequency-domain results near the reference are
 * unaffected; a TDR level or a step response, which rest on the lowest
 * frequencies, read the leak as a conductance to ground.
 */
export function constantLossDielectrics(project: ResolvedProject): string[] {
  return project.stackup.filter((l) => l.type === 'dielectric' &&
    (l.responses.permittivity ? l.responses.permittivity.lossRate > 0 : l.tanDelta > 0)).map((l) => l.name);
}

/** The ids of the ports the solve runs, one run each: analysis.excite, or every port. */
export function excitedPortIds(project: Project): string[] {
  return project.analysis.excite ?? project.ports.map((port) => port.id);
}

/**
 * outputs.array_excitation as the far field reads it: the project's map, or
 * every excited port at amplitude 1 and phase 0 when it sets none. A port the
 * map leaves out is off.
 */
export function arrayDrivesByPortId(project: Project): Record<string, ArrayPortDrive> {
  return project.outputs.array_excitation ?? Object.fromEntries(excitedPortIds(project).map((portId) => [portId, { amplitude: 1, phase_deg: 0 }]));
}

/**
 * The source behind each port when an array's far field is combined, by
 * project port index (arrayDrivesByPortId). null for a port that is off, which
 * stays a matched load.
 */
export function arrayPortDrives(project: Project): Array<PortDrive | null> {
  const drivesByPortId = arrayDrivesByPortId(project);
  return project.ports.map((port) => {
    const drive = drivesByPortId[port.id];
    return drive && drive.amplitude > 0 ? { amplitude: drive.amplitude, phaseDeg: drive.phase_deg } : null;
  });
}

/** The driven ports alone, by id, in project order, as the far-field reports list them. */
export function drivenPorts(project: Project, drives: Array<PortDrive | null>): Array<{ portId: string } & PortDrive> {
  return drives.flatMap((drive, portIndex) => (drive ? [{ portId: project.ports[portIndex].id, ...drive }] : []));
}

/**
 * outputs.array_excitation after an edit that removes ports or stops exciting
 * them: the drives of the ports that pass, or undefined (every excited port
 * driven in phase) once no kept port has an amplitude above 0 or fewer than
 * two ports are left.
 */
export function keptArrayExcitation(
  drivesByPortId: Record<string, ArrayPortDrive>, keepPortId: (portId: string) => boolean, portsLeft: number,
): Record<string, ArrayPortDrive> | undefined {
  const kept = Object.fromEntries(Object.entries(drivesByPortId).filter(([portId]) => keepPortId(portId)));
  return portsLeft >= 2 && Object.values(kept).some((drive) => drive.amplitude > 0) ? kept : undefined;
}
