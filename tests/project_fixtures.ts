import { readFileSync } from 'node:fs';

export const EXAMPLE_PATH = 'examples/patch-5g8.json';

/** The demo patch project as raw JSON (a fresh copy each call). */
export function exampleJson(): Record<string, any> {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
}

export const rect = (x0: string, y0: string, x1: string, y1: string) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/**
 * A 6 mm patch on a 10 x 10 mm board with 1 mm cells: 26 x 26 x 15 cells,
 * a few hundred steps solve in well under a second on the CPU.
 */
export function smallProjectJson(): Record<string, any> {
  const pml = { type: 'pml', cells: 6 };
  return {
    noburf_project: 1,
    name: 'small-patch',
    variables: { patch: { value: '6 mm' } },
    materials: {},
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'core', material: 'FR-4', thickness: '1 mm' },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline: rect('-5 mm', '-5 mm', '5 mm', '5 mm') },
    geometry: {
      gnd: [{ id: 'ground', op: 'add', polygon: rect('-5 mm', '-5 mm', '5 mm', '5 mm') }],
      top: [
        { id: 'patch', op: 'add', polygon: rect('-patch / 2', '-patch / 2', 'patch / 2', 'patch / 2') },
        { id: 'feed', op: 'add', polygon: rect('-1 mm', '-patch / 2 - 1 mm', '1 mm', '-patch / 2') },
      ],
    },
    ports: [{ id: 'p1', x: '0 mm', y: '-patch / 2 - 1 mm', between: ['top', 'gnd'], reference_impedance_ohm: 50 }],
    boundaries: { x_min: pml, x_max: pml, y_min: pml, y_max: pml, z_min: { type: 'pec' }, z_max: pml },
    mesh: { cell: '1 mm', air_margin_cells: { xy: 2, below: 2, above: 6 } },
    analysis: { f_min_ghz: 8, f_max_ghz: 16, n_freq: 41, loss_reference_ghz: 12, stop: { energy_decay_db: 30, max_steps: 3000 } },
    outputs: { zin_at_ghz: [12] },
  };
}

/**
 * The fixture with its FR-4 layers on the constant-conductivity loss (dispersion "conductivity"): the main
 * kernels' plain lossy update, with no dispersive edges. In place; returns json.
 */
export function withConstantLossFr4(json: Record<string, any>): Record<string, any> {
  json.materials['FR-4 constant loss'] = { eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'conductivity' } };
  for (const layer of json.stackup) if (layer.type === 'dielectric' && layer.material === 'FR-4') layer.material = 'FR-4 constant loss';
  return json;
}

/**
 * smallProjectJson on Djordjevic-Sarkar FR-4 with a 1 mm lossy ferrite cover
 * over the top copper (constant-plus-Lorentz permeability, Debye
 * permittivity): every kind of dispersive and magnetic edge, interfaces included.
 */
export function dispersiveProjectJson(): Record<string, any> {
  const json = smallProjectJson();
  json.materials = {
    'FR-4 wideband': { eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'djordjevic_sarkar', at_ghz: 1 } },
    ferrite: {
      eps_r: 12, tan_delta: 0.1, dispersion: { model: 'poles', at_ghz: 12, poles: [{ type: 'debye', delta: 2, f_relax_ghz: 5 }] },
      mu_r: 4, mu_tan_delta: 0.2, mu_dispersion: { model: 'poles', at_ghz: 12, poles: [{ type: 'lorentz', delta: 2, f_res_ghz: 20, damping_ghz: 5 }] },
    },
  };
  json.stackup[1].material = 'FR-4 wideband';
  json.stackup.push({ type: 'dielectric', name: 'cover', material: 'ferrite', thickness: '1 mm' });
  return json;
}

/**
 * A 2 mm wide, 14 mm long microstrip on 1 mm FR-4 (about 50 ohm) with a
 * port at each end and an open stub on one side near port p1, so the two
 * ports see different structures. 1 mm cells.
 */
export function twoPortLineJson(): Record<string, any> {
  const pml = { type: 'pml', cells: 6 };
  return {
    noburf_project: 1,
    name: 'two-port-line',
    variables: { half_len: { value: '7 mm' } },
    materials: {},
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'core', material: 'FR-4', thickness: '1 mm' },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline: rect('-4 mm', '-half_len', '4 mm', 'half_len') },
    geometry: {
      gnd: [{ id: 'ground', op: 'add', polygon: rect('-4 mm', '-half_len', '4 mm', 'half_len') }],
      top: [
        { id: 'line', op: 'add', polygon: rect('-1 mm', '-half_len', '1 mm', 'half_len') },
        { id: 'stub', op: 'add', polygon: rect('1 mm', '-4 mm', '3 mm', '-2 mm') },
      ],
    },
    ports: [
      { id: 'p1', x: '0 mm', y: '-half_len', between: ['top', 'gnd'], reference_impedance_ohm: 50 },
      { id: 'p2', x: '0 mm', y: 'half_len', between: ['top', 'gnd'], reference_impedance_ohm: 50 },
    ],
    boundaries: { x_min: pml, x_max: pml, y_min: pml, y_max: pml, z_min: { type: 'pec' }, z_max: pml },
    mesh: { cell: '1 mm', air_margin_cells: { xy: 2, below: 2, above: 6 } },
    analysis: { f_min_ghz: 1, f_max_ghz: 10, n_freq: 19, loss_reference_ghz: 5, stop: { energy_decay_db: 40, max_steps: 4000 } },
    outputs: { zin_at_ghz: [5] },
  };
}

/**
 * twoPortLineJson's line with an edge-launch SMA on its y_min end instead of
 * the two lumped ports: graded mesh, and air margins that fit the connector
 * (the coax runs about 16 mm out from the board edge).
 */
export function smaEdgeLineJson(): Record<string, any> {
  const json = twoPortLineJson();
  json.name = 'sma-edge-line';
  json.geometry.top = [json.geometry.top[0]];
  json.ports = [{ id: 'sma', kind: 'sma_edge', x: '0 mm', edge: 'y_min', between: ['top', 'gnd'], reference_impedance_ohm: 50 }];
  json.mesh = { cell: '1 mm', air_margin_cells: { xy: 18, below: 3, above: 6 }, graded: { edge_cell: '0.25 mm', dielectric_cells: 4, max_growth: 1.3 } };
  json.analysis = { ...json.analysis, f_min_ghz: 2, f_max_ghz: 8, n_freq: 13, stop: { energy_decay_db: 40, max_steps: 30000 } };
  return json;
}

/** smaEdgeLineJson's line with an SMA on each end (y_min and y_max): a two-port through line. */
export function smaThroughLineJson(): Record<string, any> {
  const json = smaEdgeLineJson();
  json.name = 'sma-through-line';
  json.ports = [
    { id: 'in', kind: 'sma_edge', x: '0 mm', edge: 'y_min', between: ['top', 'gnd'], reference_impedance_ohm: 50 },
    { id: 'out', kind: 'sma_edge', x: '0 mm', edge: 'y_max', between: ['top', 'gnd'], reference_impedance_ohm: 50 },
  ];
  json.mesh.air_margin_cells = { xy: 4, below: 3, above: 6 };
  return json;
}

/**
 * A 10 mm square patch on a 24 mm board of 1.6 mm FR-4, fed at (0, -2.5 mm)
 * by a coax probe through the ground plane, or by a lumped port at the same
 * point. The ground is finite and z_min is a PML, so the probe's coax can run
 * out below the board. Resonance near 7 GHz.
 */
export function probePatchJson(kind: 'coax_probe' | 'lumped'): Record<string, any> {
  const pml = { type: 'pml', cells: 6 };
  return {
    noburf_project: 1,
    name: `probe-patch-${kind}`,
    variables: { patch: { value: '10 mm' } },
    materials: {},
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'core', material: 'FR-4', thickness: '1.6 mm' },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline: rect('-12 mm', '-12 mm', '12 mm', '12 mm') },
    geometry: {
      gnd: [{ id: 'ground', op: 'add', polygon: rect('-12 mm', '-12 mm', '12 mm', '12 mm') }],
      top: [{ id: 'patch', op: 'add', polygon: rect('-patch / 2', '-patch / 2', 'patch / 2', 'patch / 2') }],
    },
    ports: [{ id: 'probe', ...(kind === 'lumped' ? {} : { kind }), x: '0 mm', y: '-2.5 mm', between: ['top', 'gnd'], reference_impedance_ohm: 50 }],
    boundaries: { x_min: pml, x_max: pml, y_min: pml, y_max: pml, z_min: pml, z_max: pml },
    mesh: { cell: '1 mm', air_margin_cells: { xy: 4, below: 4, above: 8 }, graded: { edge_cell: '0.25 mm', dielectric_cells: 4, max_growth: 1.3 } },
    analysis: { f_min_ghz: 5, f_max_ghz: 9, n_freq: 81, loss_reference_ghz: 7, stop: { energy_decay_db: 40, max_steps: 40000 } },
    outputs: { zin_at_ghz: [7] },
  };
}

/**
 * twoPortLineJson's line alone, with 3 mm of feed de-embedded at each port:
 * small enough that the project and its kit (a thru and two lines, shared by
 * both ports) solve in seconds on the CPU.
 */
export function deembedLineJson(): Record<string, any> {
  const json = twoPortLineJson();
  json.name = 'deembed-line';
  json.geometry.top = [json.geometry.top[0]];
  for (const port of json.ports) port.deembed = { length: '3 mm' };
  return json;
}
