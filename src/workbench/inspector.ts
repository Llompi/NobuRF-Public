/**
 * Property editor for the selected tree item. Every input is bound to a JSON
 * path of the document and commits on change (Enter or leaving the field).
 * There is no validation here: the schema checks the whole document after
 * each edit, and its message appears under the field whose path it names.
 */
import { evaluateLength, type Quantity } from '../project/expression';
import { BUILTIN_MATERIALS, FACES, type DielectricMaterial, type Port, type Project, type SmaEdgePort } from '../project/schema';
import { escapeHtml } from '../ui/format';
import * as actions from './doc_actions';
import { isConductor, MATERIAL_LIBRARY } from './material_library';
import { parseSelectionKey, selectionForErrorPath, selectionKey, type Selection } from './selection';
import { getAt, pathString, setAt, type JsonPath, type ProjectStore } from './store';

type Kind = 'length' | 'number' | 'integer' | 'text' | 'bool' | 'select' | 'numbers';

interface Field {
  label: string;
  path: JsonPath;
  kind: Kind;
  unit?: string;
  /** Choices; consecutive options with the same group are shown under that heading. */
  options?: Array<[value: string, label: string, group?: string]>;
  hint?: string;
  /** Applies a rename (or other structural change) instead of setting the value. */
  rename?: (doc: Project, value: string) => Project;
}

const FACE_LABELS: Record<string, string> = {
  x_min: 'x min', x_max: 'x max', y_min: 'y min', y_max: 'y max', z_min: 'z min (below)', z_max: 'z max (above)',
};

let fieldCounter = 0;

/** Select value of a library material that is not in the project yet. */
const LIBRARY_PREFIX = 'library:';

const EDGE_OPTIONS: Array<[SmaEdgePort['edge'], string]> = [['y_min', 'y min'], ['y_max', 'y max'], ['x_min', 'x min'], ['x_max', 'x max']];

const PORT_ABOUT: Record<NonNullable<Port['kind']>, string> = {
  lumped: 'A lumped port: a vertical source column between two copper layers.',
  sma_edge: 'An edge-launch SMA connector, modeled in the grid. S and Z are referred to its flange, as a VNA calibrated at the connector reads them. Solves on the CPU.',
  coax_probe: 'An SMA coax line coming up through the ground plane, as in a probe-fed patch. S and Z are referred to its flange on the underside of the ground plane. Solves on the CPU.',
};

const VIA_ABOUT = 'A plated hole from one copper layer to another, joined to the copper it touches. It must land on copper at both ends.';

const COMPONENT_ABOUT = {
  between: 'A lumped part standing between two copper layers at one point, such as a shunt capacitor from a pad to ground. It covers one column of cells.',
  layer: 'A lumped part on one copper layer, bridging a gap from one pad to the other, such as a chip resistor in series with a trace. Leave a gap in the copper under it.',
};

export class Inspector {
  private selection: Selection = { kind: 'project' };

  constructor(
    private readonly root: HTMLElement,
    private readonly store: ProjectStore,
    /** Select another tree item (after an add, or to jump to an error). */
    private readonly select: (key: string) => void,
    /** A line in the message log. */
    private readonly report: (kind: 'info' | 'warning', text: string) => void = () => {},
  ) {
    root.addEventListener('change', (event) => this.onChange(event.target as HTMLInputElement | HTMLSelectElement));
    root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (button) this.onAction(button.dataset.act!, button.dataset.arg);
    });
  }

  show(key: string): void {
    this.selection = parseSelectionKey(key);
    this.render();
  }

  private get doc(): Project {
    return this.store.document as Project;
  }

  private get variables(): Record<string, Quantity> | null {
    return this.store.lastValid?.resolved?.variables ?? null;
  }

  render(): void {
    const active = document.activeElement as HTMLElement | null;
    const focusedPath = this.root.contains(active) ? active?.dataset.path : undefined;
    let body: string;
    try {
      body = this.body();
    } catch {
      // The document is too broken for this editor (e.g. the item was removed); fall back to the project view.
      this.selection = { kind: 'project' };
      body = this.body();
    }
    this.root.innerHTML = this.errorBanner() + body;
    if (focusedPath) this.root.querySelector<HTMLElement>(`[data-path="${CSS.escape(focusedPath)}"]`)?.focus();
  }

  /** The schema error, when it belongs to another item than the one shown. */
  private errorBanner(): string {
    const error = this.store.validation.error;
    if (!error) return '';
    const owner = selectionKey(selectionForErrorPath(error.path));
    const here = owner === selectionKey(this.selection);
    // Shown under its field when that field is on screen; the banner covers every other case.
    if (here && this.fields().some((f) => this.fieldOwnsError(f, error.path))) return '';
    const jump = here ? '' : `<button type="button" data-act="goto" data-arg="${escapeHtml(owner)}">Show</button>`;
    return `<div class="problem" role="alert"><p><strong>The project can't be solved yet.</strong> <code>${escapeHtml(error.path)}</code>: ${escapeHtml(error.message)}</p>${jump}</div>`;
  }

  /**
   * The one field on screen that shows the schema error: the first whose path
   * the error is at or inside, else the first inside the object the error
   * names (an error on "$.boundaries.z_max" shows at its type). Rename fields
   * never take it: their path is the whole item.
   */
  private fieldOwnsError(f: Field, errorPath: string): boolean {
    const candidates = this.fields().filter((x) => !x.rename && x.path.at(-1) !== '@graded');
    const p = (x: Field) => pathString(x.path);
    const owner = candidates.find((x) => errorPath === p(x) || errorPath.startsWith(p(x) + '[') || errorPath.startsWith(p(x) + '.'))
      ?? candidates.find((x) => p(x).startsWith(errorPath + '.') || p(x).startsWith(errorPath + '['));
    return owner !== undefined && JSON.stringify(owner.path) === JSON.stringify(f.path);
  }

  /* ---------------------------------------------------------------------- */

  private fields(): Field[] {
    const s = this.selection;
    const d = this.doc;
    // The project's own materials (built-in and added), then library entries not yet in the project: choosing one copies it in.
    const materialOptions = (conductor: boolean): Array<[string, string, string]> => {
      const own = [...Object.entries(BUILTIN_MATERIALS).filter(([, m]) => (m.kind === 'dielectric') !== conductor).map(([n]) => n),
        ...Object.entries(d.materials ?? {}).filter(([, m]) => ('conductivity_s_per_m' in m) === conductor).map(([n]) => n)];
      // A name already taken, by a material of either kind or a built-in, cannot come in from the library.
      const taken = (name: string) => Object.hasOwn(BUILTIN_MATERIALS, name) || Object.hasOwn(d.materials ?? {}, name);
      const library = MATERIAL_LIBRARY.filter((m) => isConductor(m) === conductor && !taken(m.name));
      return [...own.map((n): [string, string, string] => [n, n, 'In this project']),
        ...library.map((m): [string, string, string] => [`${LIBRARY_PREFIX}${m.name}`, isConductor(m) ? m.name : `${m.name}  εr ${m.eps_r}, tan δ ${m.tan_delta}`, 'From the library'])];
    };
    const conductorOptions = () => materialOptions(true);
    const dielectricOptions = () => materialOptions(false);
    const copperOptions = () => d.stackup.filter((l) => l.type === 'copper').map((l): [string, string] => [l.name, l.name]);
    switch (s.kind) {
      case 'project':
        return [{ label: 'Name', path: ['name'], kind: 'text' }];
      case 'board':
        return d.board.outline.flatMap((_, n): Field[] => [
          { label: `x${n + 1}`, path: ['board', 'outline', n, 0], kind: 'length' },
          { label: `y${n + 1}`, path: ['board', 'outline', n, 1], kind: 'length' },
        ]);
      case 'variable': {
        const p = ['variables', s.name];
        const def = d.variables[s.name];
        // The tuner may change an unlocked length, only within limits the user set (tuningDesignFromProject).
        const tunable = def && !def.locked && this.variables?.[s.name]?.dim === 1;
        return [
          { label: 'Name', path: [...p, '@name'], kind: 'text', rename: (doc, v) => actions.renameVariable(doc, s.name, v) },
          { label: 'Value', path: [...p, 'value'], kind: 'length', hint: 'A length ("12.4 mm", "patch_w / 2") or a plain number.' },
          { label: 'Minimum', path: [...p, 'min'], kind: 'length', ...(tunable && def.min === undefined ? { hint: 'Not set: the AI tuner refuses this project until you set a minimum or lock the variable.' } : {}) },
          { label: 'Maximum', path: [...p, 'max'], kind: 'length', ...(tunable && def.max === undefined ? { hint: 'Not set: the AI tuner refuses this project until you set a maximum or lock the variable.' } : {}) },
          { label: 'Locked', path: [...p, 'locked'], kind: 'bool', hint: 'Edits from scripts and the tuning agent cannot change a locked variable.' },
        ];
      }
      case 'material': {
        const p = ['materials', s.name];
        const m = d.materials[s.name];
        const rename: Field = { label: 'Name', path: [...p, '@name'], kind: 'text', rename: (doc, v) => actions.renameMaterial(doc, s.name, v) };
        return m && 'conductivity_s_per_m' in m
          ? [rename, { label: 'Conductivity', path: [...p, 'conductivity_s_per_m'], kind: 'number', unit: 'S/m' }]
          : [rename, ...dielectricFields(p, m as DielectricMaterial | undefined)];
      }
      case 'layer': {
        const p = ['stackup', s.index];
        const layer = d.stackup[s.index];
        const name: Field = { label: 'Name', path: [...p, '@name'], kind: 'text', rename: (doc, v) => actions.renameLayer(doc, s.index, v) };
        return layer.type === 'copper'
          ? [name, { label: 'Metal', path: [...p, 'material'], kind: 'select', options: conductorOptions(), hint: '"pec" is lossless; "copper" adds the skin-effect surface impedance, growing as √f across the band.' }]
          : [name, { label: 'Material', path: [...p, 'material'], kind: 'select', options: dielectricOptions() }, { label: 'Thickness', path: [...p, 'thickness'], kind: 'length' }];
      }
      case 'shape': {
        const p = ['geometry', s.layer, s.index];
        const shape = d.geometry[s.layer][s.index];
        return [
          { label: 'Name', path: [...p, 'id'], kind: 'text' },
          { label: 'Operation', path: [...p, 'op'], kind: 'select', options: [['add', 'Add copper'], ['cut', 'Cut copper']], hint: 'Shapes are painted in list order; a cut removes copper painted before it.' },
          ...shape.polygon.flatMap((_, n): Field[] => [
            { label: `x${n + 1}`, path: [...p, 'polygon', n, 0], kind: 'length' },
            { label: `y${n + 1}`, path: [...p, 'polygon', n, 1], kind: 'length' },
          ]),
        ];
      }
      case 'port': {
        const p = ['ports', s.index];
        const port = d.ports[s.index];
        const kindFields = (): Field[] => {
          if (port?.kind === 'sma_edge') {
            const along = port.edge[0] === 'y' ? 'x' : 'y';
            return [
              { label: 'Board edge', path: [...p, '@edge'], kind: 'select', options: EDGE_OPTIONS, rename: (doc, v) => actions.setSmaEdge(doc, s.index, v as SmaEdgePort['edge']) },
              { label: along, path: [...p, along], kind: 'length', hint: 'Where the connector sits along the edge. The signal copper must reach the edge there.' },
              { label: 'Signal layer', path: [...p, 'between', 0], kind: 'select', options: copperOptions(), hint: 'The pin rests on this copper.' },
              { label: 'Ground layer', path: [...p, 'between', 1], kind: 'select', options: copperOptions(), hint: 'The connector body bonds to this copper.' },
            ];
          }
          if (port?.kind === 'coax_probe') {
            return [
              { label: 'x', path: [...p, 'x'], kind: 'length' },
              { label: 'y', path: [...p, 'y'], kind: 'length', hint: 'The pin rises here from below the board. Signal copper must cover this point.' },
              { label: 'Signal layer', path: [...p, 'between', 0], kind: 'select', options: copperOptions(), hint: 'The pin ends on this copper.' },
              { label: 'Ground layer', path: [...p, 'between', 1], kind: 'select', options: copperOptions(), hint: 'The bottom copper: the coax shield bonds to it, and a clearance is cut around the pin.' },
            ];
          }
          return [
            { label: 'x', path: [...p, 'x'], kind: 'length' },
            { label: 'y', path: [...p, 'y'], kind: 'length' },
            { label: 'From layer', path: [...p, 'between', 0], kind: 'select', options: copperOptions() },
            { label: 'To layer', path: [...p, 'between', 1], kind: 'select', options: copperOptions() },
            { label: 'De-embed feed', path: [...p, 'deembed'], kind: 'length',
              hint: 'Removes the port and this much of its straight feed line from the results, with a calibration kit solved from the project. Empty: results at the port.' },
          ];
        };
        return [
          { label: 'Name', path: [...p, '@name'], kind: 'text', rename: (doc, v) => actions.renamePort(doc, s.index, v) },
          { label: 'Type', path: [...p, '@kind'], kind: 'select', options: [['lumped', 'Lumped port'], ['sma_edge', 'SMA edge connector'], ['coax_probe', 'Coax probe from below']],
            rename: (doc, v) => actions.setPortKind(doc, s.index, v) },
          ...kindFields(),
          { label: 'Reference impedance', path: [...p, 'reference_impedance_ohm'], kind: 'number', unit: 'Ω' },
        ];
      }
      case 'component': {
        const p = ['components', s.index];
        const c = d.components?.[s.index];
        const placeFields: Field[] = c && 'layer' in c
          ? [
            { label: 'Layer', path: [...p, 'layer'], kind: 'select', options: copperOptions() },
            { label: 'From x', path: [...p, 'from', 0], kind: 'length' },
            { label: 'From y', path: [...p, 'from', 1], kind: 'length' },
            { label: 'To x', path: [...p, 'to', 0], kind: 'length' },
            { label: 'To y', path: [...p, 'to', 1], kind: 'length', hint: 'From one pad edge to the other, along x or along y.' },
            { label: 'Width', path: [...p, 'width'], kind: 'length', hint: 'The part body across the gap. Empty: one grid line, zero width.' },
          ]
          : [
            { label: 'x', path: [...p, 'x'], kind: 'length' },
            { label: 'y', path: [...p, 'y'], kind: 'length' },
            { label: 'From layer', path: [...p, 'between', 0], kind: 'select', options: copperOptions() },
            { label: 'To layer', path: [...p, 'between', 1], kind: 'select', options: copperOptions() },
          ];
        return [
          { label: 'Name', path: [...p, '@name'], kind: 'text', rename: (doc, v) => actions.renameComponent(doc, s.index, v) },
          { label: 'Placement', path: [...p, '@placement'], kind: 'select', options: [['between', 'Between two layers'], ['layer', 'Across a gap on a layer']],
            rename: (doc, v) => actions.setComponentPlacement(doc, s.index, v) },
          ...placeFields,
          { label: 'Resistance', path: [...p, 'r_ohm'], kind: 'number', unit: 'Ω' },
          { label: 'Inductance', path: [...p, 'l_nh'], kind: 'number', unit: 'nH' },
          { label: 'Capacitance', path: [...p, 'c_pf'], kind: 'number', unit: 'pF', hint: 'Leave a value empty to leave that part out.' },
          { label: 'Connection', path: [...p, 'connection'], kind: 'select',
            options: [...(c?.connection === undefined ? [['', 'Not set'] as [string, string]] : []), ['series', 'In series'], ['parallel', 'In parallel']],
            hint: 'How the parts that have a value are joined. Needed with two or more.' },
        ];
      }
      case 'via': {
        const p = ['vias', s.index];
        const v = d.vias?.[s.index];
        return [
          { label: 'Name', path: [...p, '@name'], kind: 'text', rename: (doc, value) => actions.renameVia(doc, s.index, value) },
          { label: 'Type', path: [...p, '@fence'], kind: 'select', options: [['single', 'One via'], ['fence', 'Fence (a row of vias)']],
            rename: (doc, value) => actions.setViaFence(doc, s.index, value) },
          { label: v?.to === undefined ? 'x' : 'From x', path: [...p, 'x'], kind: 'length' },
          { label: v?.to === undefined ? 'y' : 'From y', path: [...p, 'y'], kind: 'length' },
          ...(v?.to === undefined ? [] : [
            { label: 'To x', path: [...p, 'to', 0], kind: 'length' },
            { label: 'To y', path: [...p, 'to', 1], kind: 'length' },
            { label: 'Pitch', path: [...p, 'pitch'], kind: 'length', hint: 'Center to center. The first via is at the start; the last is the one that still fits.' },
          ] as Field[]),
          { label: 'Drill', path: [...p, 'drill'], kind: 'length', hint: 'The finished hole: the barrel is solid metal of this diameter.' },
          { label: 'From layer', path: [...p, 'between', 0], kind: 'select', options: copperOptions() },
          { label: 'To layer', path: [...p, 'between', 1], kind: 'select', options: copperOptions() },
          { label: 'Antipad', path: [...p, 'antipad'], kind: 'length', hint: 'Clearance cut in the copper layers in between. Empty: the via joins any copper it passes through.' },
        ];
      }
      case 'boundaries':
        return FACES.flatMap((face): Field[] => [
          { label: FACE_LABELS[face], path: ['boundaries', face, 'type'], kind: 'select', options: [['pml', 'Absorbing (PML)'], ['pec', 'Metal wall (PEC)']] },
          ...(d.boundaries[face]?.type === 'pml' ? [{ label: 'Cells', path: ['boundaries', face, 'cells'], kind: 'integer' } as Field] : []),
        ]);
      case 'mesh':
        return [
          { label: d.mesh.graded ? 'Largest cell' : 'Cell', path: ['mesh', 'cell'], kind: 'length' },
          { label: 'Air beside the board', path: ['mesh', 'air_margin_cells', 'xy'], kind: 'integer', unit: 'cells' },
          { label: 'Air below', path: ['mesh', 'air_margin_cells', 'below'], kind: 'integer', unit: 'cells' },
          { label: 'Air above', path: ['mesh', 'air_margin_cells', 'above'], kind: 'integer', unit: 'cells' },
          { label: 'Graded', path: ['mesh', '@graded'], kind: 'bool', hint: 'Puts mesh lines on every copper edge, the port and the layer interfaces, so nothing snaps to the grid.' },
          { label: 'Conformal copper', path: ['mesh', 'conformal'], kind: 'bool', hint: 'Models slanted and curved copper edges by how much of each cell they cover, instead of as steps of whole cells.' },
          ...(d.mesh.graded ? [
            { label: 'Cell at copper edges', path: ['mesh', 'graded', 'edge_cell'], kind: 'length' },
            { label: 'Cells across a dielectric', path: ['mesh', 'graded', 'dielectric_cells'], kind: 'integer' },
            { label: 'Largest growth between cells', path: ['mesh', 'graded', 'max_growth'], kind: 'number' },
          ] as Field[] : []),
        ];
      case 'analysis':
        return [
          { label: 'Lowest frequency', path: ['analysis', 'f_min_ghz'], kind: 'number', unit: 'GHz' },
          { label: 'Highest frequency', path: ['analysis', 'f_max_ghz'], kind: 'number', unit: 'GHz' },
          { label: 'Frequency points', path: ['analysis', 'n_freq'], kind: 'integer' },
          { label: 'Loss reference', path: ['analysis', 'loss_reference_ghz'], kind: 'number', unit: 'GHz', hint: 'Materials without their own reference frequency have their εr and loss tangent exactly here. Copper loss follows √f across the band.' },
          { label: 'Stop when energy falls', path: ['analysis', 'stop', 'energy_decay_db'], kind: 'number', unit: 'dB' },
          { label: 'Step limit', path: ['analysis', 'stop', 'max_steps'], kind: 'integer' },
          { label: 'Report Z at', path: ['outputs', 'zin_at_ghz'], kind: 'numbers', unit: 'GHz', hint: 'Comma-separated frequencies.' },
          { label: 'Far field at', path: ['outputs', 'far_field_ghz'], kind: 'numbers', unit: 'GHz', hint: 'Leave empty for no far field. Needs a PML on every face and 4 cells of air on every side.' },
          { label: 'Near-field scan at', path: ['outputs', 'near_field_mm'], kind: 'numbers', unit: 'mm', hint: 'Heights above the top copper, up to 4. Leave empty for no scan. Each must fit in the air below the PML on top.' },
        ];
      default:
        return [];
    }
  }

  private body(): string {
    const s = this.selection;
    const d = this.doc;
    const fields = this.fields();
    const header = (title: string, detail = '') => `<header class="inspector-head"><h2>${escapeHtml(title)}</h2>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</header>`;
    const buttons = (list: Array<[act: string, label: string, arg?: string]>) =>
      `<div class="inspector-actions">${list.map(([act, label, arg]) => `<button type="button" data-act="${act}"${arg !== undefined ? ` data-arg="${escapeHtml(arg)}"` : ''}>${escapeHtml(label)}</button>`).join('')}</div>`;
    const form = (list: Field[]) => `<div class="form">${list.map((f) => this.fieldHtml(f)).join('')}</div>`;
    switch (s.kind) {
      case 'project':
        return header('Project', this.store.fileName) + form(fields) + this.projectSummary();
      case 'board':
        return header('Board outline', 'Every dielectric layer fills this outline; copper outside it is ignored.') + this.polygonTable(fields);
      case 'variable':
        return header('Variable', 'Lengths can use other variables.') + form(fields) + buttons([['remove-variable', 'Delete variable']]);
      case 'material':
        return header('Material') + form(fields) + buttons([['remove-material', 'Delete material']]);
      case 'layer': {
        const layer = d.stackup[s.index];
        return header(layer.type === 'copper' ? 'Copper layer' : 'Dielectric layer', `Layer ${s.index + 1} of ${d.stackup.length}, counted from the bottom.`) + form(fields) +
          buttons([['move-layer-up', 'Move up'], ['move-layer-down', 'Move down'], ['remove-layer', 'Delete layer']]);
      }
      case 'shape':
        return header('Copper shape', `On layer ${s.layer}, painted ${ordinal(s.index + 1)} of ${d.geometry[s.layer].length}.`) +
          form(fields.slice(0, 2)) + this.polygonTable(fields.slice(2)) +
          (actions.canMakeEditable(d.geometry[s.layer][s.index]) ? this.anchorForm() : '') +
          buttons([
            ...(actions.canMakeEditable(d.geometry[s.layer][s.index]) ? [['make-editable', 'Make editable'] as [string, string]] : []),
            ['duplicate-shape', 'Duplicate'], ['remove-shape', 'Delete shape'],
          ]);
      case 'port':
        return header(`Port ${s.index + 1}`, PORT_ABOUT[this.doc.ports[s.index]?.kind ?? 'lumped']) + form(fields) + buttons([['remove-port', 'Delete port']]);
      case 'component': {
        const c = this.doc.components?.[s.index];
        return header('Component', COMPONENT_ABOUT[c && 'layer' in c ? 'layer' : 'between']) + form(fields) + buttons([['remove-component', 'Delete component']]);
      }
      case 'via':
        return header(this.doc.vias?.[s.index]?.to === undefined ? 'Via' : 'Via fence', VIA_ABOUT) + form(fields) + buttons([['remove-via', this.doc.vias?.[s.index]?.to === undefined ? 'Delete via' : 'Delete fence']]);
      case 'boundaries':
        return header('Boundaries', 'What surrounds the solve box on each face.') + `<div class="form boundary-form">${fields.map((f) => this.fieldHtml(f)).join('')}</div>`;
      case 'mesh':
        return header('Mesh') + form(fields) + this.meshSummary();
      case 'analysis':
        return header('Analysis and outputs') + form(fields) + this.exciteChecks();
      default:
        return header('Nothing selected');
    }
  }

  /** The anchor choice for Make editable: which part of the rectangle stays put along x and along y. */
  private anchorForm(): string {
    const select = (axis: 'x' | 'y', low: string, high: string) =>
      `<div class="field"><label for="anchor-${axis}">Keep fixed along ${axis}</label><select id="anchor-${axis}">` +
      [['auto', 'Auto: touching copper or port'], ['min', low], ['mid', 'Middle'], ['max', high]]
        .map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`).join('') + '</select></div>';
    return `<div class="form">${select('x', 'Left edge', 'Right edge')}${select('y', 'Bottom edge', 'Top edge')}</div>` +
      '<p class="hint">Make editable adds variables for its size along x and y; set a minimum and maximum on each for the AI tuner. ' +
      'The part kept fixed stays put when it is resized. With Auto, edges touching other copper or a port stay on it: ' +
      'a line touching something at both ends keeps both, and follows them if they are editable. ' +
      'Make a patch editable before its feed line, so the feed follows the patch.</p>';
  }

  private projectSummary(): string {
    const r = this.store.lastValid?.resolved;
    if (!r) return '';
    const xs = r.boardOutline.map((p) => p[0]);
    const ys = r.boardOutline.map((p) => p[1]);
    const thickness = r.stackup.reduce((t, l) => t + (l.type === 'dielectric' ? l.thicknessMm : 0), 0);
    const shapes = Object.values(r.copper).reduce((n, list) => n + list.length, 0);
    const rows: Array<[string, string]> = [
      ['Board', `${fmtMm(Math.max(...xs) - Math.min(...xs))} × ${fmtMm(Math.max(...ys) - Math.min(...ys))} mm`],
      ['Stackup', `${r.stackup.length} layers, ${fmtMm(thickness)} mm thick`],
      ['Copper shapes', String(shapes)],
      ['Ports', r.ports.map((p) => p.id).join(', ')],
      ...(r.components.length ? [['Components', r.components.map((c) => c.id).join(', ')] as [string, string]] : []),
      ...(r.vias.length ? [['Vias', String(r.vias.length)] as [string, string]] : []),
    ];
    return `<dl class="summary">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
  }

  private meshSummary(): string {
    const r = this.store.lastValid?.resolved;
    if (!r) return '';
    const note = r.graded
      ? `Cells grow from ${fmtMm(r.graded.edgeCellMm)} mm at copper edges to at most ${fmtMm(r.cellMm)} mm. The time step follows the smallest cell.`
      : `Uniform ${fmtMm(r.cellMm)} mm cubes. Copper edges, ports and layer thicknesses snap to the grid.`;
    return `<p class="note">${escapeHtml(note)}</p>`;
  }

  private exciteChecks(): string {
    const d = this.doc;
    if (d.ports.length < 2) return '';
    const excite = d.analysis.excite ?? d.ports.map((p) => p.id);
    return `<fieldset class="checks"><legend>Excite</legend>${d.ports.map((p) =>
      `<label class="toggle"><input type="checkbox" data-excite="${escapeHtml(p.id)}"${excite.includes(p.id) ? ' checked' : ''} /> ${escapeHtml(p.id)}</label>`).join('')}` +
      '<p class="note">One solver run per excited port. With every port excited the full S-matrix is written.</p></fieldset>';
  }

  private polygonTable(points: Field[]): string {
    const rows: string[] = [];
    for (let n = 0; n < points.length; n += 2) {
      rows.push(`<tr><th scope="row">${n / 2 + 1}</th><td>${this.inputHtml(points[n])}${this.errorFor(points[n])}</td><td>${this.inputHtml(points[n + 1])}${this.errorFor(points[n + 1])}</td>` +
        `<td><button type="button" class="icon" data-act="add-point" data-arg="${n / 2}" aria-label="Add a point after point ${n / 2 + 1}">+</button>` +
        `<button type="button" class="icon" data-act="remove-point" data-arg="${n / 2}" aria-label="Delete point ${n / 2 + 1}"${points.length <= 6 ? ' disabled title="An outline needs at least three points"' : ''}>−</button></td></tr>`);
    }
    return `<table class="points"><caption>Outline</caption><thead><tr><th scope="col">#</th><th scope="col">x</th><th scope="col">y</th><th scope="col"><span class="visually-hidden">Edit</span></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  /* ---------------------------------------------------------------------- */

  private value(f: Field): unknown {
    const last = f.path.at(-1);
    if (last === '@name') return this.renamedName();
    if (last === '@graded') return this.doc.mesh.graded !== undefined;
    if (last === '@kind') return getAt(this.doc, [...f.path.slice(0, -1), 'kind']) ?? 'lumped';
    if (last === '@edge') return getAt(this.doc, [...f.path.slice(0, -1), 'edge']);
    if (last === '@fence') return getAt(this.doc, [...f.path.slice(0, -1), 'to']) === undefined ? 'single' : 'fence';
    if (last === '@placement') return getAt(this.doc, [...f.path.slice(0, -1), 'layer']) === undefined ? 'between' : 'layer';
    if (last === 'deembed') return (getAt(this.doc, f.path) as { length?: string } | undefined)?.length;
    return getAt(this.doc, f.path);
  }

  private renamedName(): string {
    const s = this.selection;
    if (s.kind === 'variable' || s.kind === 'material') return s.name;
    if (s.kind === 'layer') return this.doc.stackup[s.index].name;
    if (s.kind === 'port') return this.doc.ports[s.index].id;
    if (s.kind === 'component') return this.doc.components![s.index].id;
    if (s.kind === 'via') return this.doc.vias![s.index].id;
    return '';
  }

  private inputHtml(f: Field): string {
    const id = `field-${++fieldCounter}`;
    const path = escapeHtml(JSON.stringify(f.path));
    const v = this.value(f);
    const label = escapeHtml(f.label);
    if (f.kind === 'bool') return `<input type="checkbox" id="${id}" data-path="${path}" data-kind="bool" aria-label="${label}"${v ? ' checked' : ''} />`;
    if (f.kind === 'select') {
      const options = [...(f.options ?? [])];
      if (typeof v === 'string' && !options.some(([o]) => o === v)) options.unshift([v, v]);
      const option = ([o, l]: [string, string, string?]) => `<option value="${escapeHtml(o)}"${o === v ? ' selected' : ''}>${escapeHtml(l)}</option>`;
      let html = '';
      for (let n = 0; n < options.length;) {
        const group = options[n][2];
        let end = n + 1;
        while (end < options.length && options[end][2] === group) end++;
        const run = options.slice(n, end).map(option).join('');
        html += group ? `<optgroup label="${escapeHtml(group)}">${run}</optgroup>` : run;
        n = end;
      }
      return `<select id="${id}" data-path="${path}" data-kind="select" aria-label="${label}">${html}</select>`;
    }
    const text = v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);
    const numeric = f.kind === 'number' || f.kind === 'integer' || f.kind === 'numbers';
    return `<input type="text" id="${id}" data-path="${path}" data-kind="${f.kind}" aria-label="${label}" value="${escapeHtml(text)}"` +
      `${numeric ? ' inputmode="decimal"' : ''} spellcheck="false" autocomplete="off" />`;
  }

  private errorFor(f: Field): string {
    const error = this.store.validation.error;
    return error && this.fieldOwnsError(f, error.path) ? `<p class="field-error" role="alert">${escapeHtml(error.message)}</p>` : '';
  }

  private fieldHtml(f: Field): string {
    const input = this.inputHtml(f);
    const id = /id="([^"]+)"/.exec(input)![1];
    const unit = f.unit ? `<span class="unit">${escapeHtml(f.unit)}</span>` : '';
    return `<div class="field${f.kind === 'bool' ? ' field-bool' : ''}"><label for="${id}">${escapeHtml(f.label)}</label>` +
      `<div class="field-input">${input}${unit}</div>${this.evaluated(f)}${this.errorFor(f)}` +
      (f.hint ? `<p class="hint">${escapeHtml(f.hint)}</p>` : '') + '</div>';
  }

  /** "= 8 mm" under a length that is an expression. */
  private evaluated(f: Field): string {
    if (f.kind !== 'length') return '';
    const v = this.value(f);
    const vars = this.variables;
    if (typeof v !== 'string' || !vars || /^\s*-?[\d.]+\s*mm\s*$/.test(v)) return '';
    try {
      const mm = evaluateLength(v, (name) => {
        if (!Object.hasOwn(vars, name)) throw new Error(`unknown variable "${name}"`);
        return vars[name];
      });
      return `<p class="evaluated">= ${escapeHtml(fmtMm(mm))} mm</p>`;
    } catch {
      return ''; // A plain number, or not evaluable yet: the schema error says why.
    }
  }

  /* ---------------------------------------------------------------------- */

  private onChange(input: HTMLInputElement | HTMLSelectElement): void {
    if (input.dataset.excite !== undefined) return this.onExcite();
    const raw = input.dataset.path;
    if (!raw) return;
    const path = JSON.parse(raw) as JsonPath;
    const kind = input.dataset.kind as Kind;
    const field = this.fields().find((f) => JSON.stringify(f.path) === raw);
    const text = input.value;
    if (field?.rename) {
      const name = text.trim();
      if (!name) return this.render();
      let next: Project;
      try {
        next = field.rename(this.doc, name);
      } catch (error) {
        input.setCustomValidity((error as Error).message);
        input.reportValidity();
        input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
        return;
      }
      this.store.update(() => next);
      this.followRename(name);
      return;
    }
    if (kind === 'select' && text.startsWith(LIBRARY_PREFIX)) {
      const name = text.slice(LIBRARY_PREFIX.length);
      this.store.update((doc) => setAt(actions.useLibraryMaterial(doc as Project, name), path, name));
      return;
    }
    if (path.at(-1) === '@graded') {
      const on = (input as HTMLInputElement).checked;
      this.store.set(['mesh', 'graded'], on ? { edge_cell: '0.25 mm', dielectric_cells: 6, max_growth: 1.3 } : undefined);
      return;
    }
    if (kind === 'bool') {
      // An unlocked variable has no "locked" key, as the schema documents.
      const checked = (input as HTMLInputElement).checked;
      this.store.set(path, checked ? true : path.at(-1) === 'locked' ? undefined : false);
      return;
    }
    if (path.at(-1) === 'deembed') {
      this.store.set(path, text.trim() ? { length: text.trim() } : undefined);
      return;
    }
    if (kind === 'select' && path.at(-1) === 'type' && path[0] === 'boundaries') {
      this.store.set(path.slice(0, -1), text === 'pml' ? { type: 'pml', cells: 8 } : { type: 'pec' });
      return;
    }
    this.store.set(path, parseInput(kind, text, path));
  }

  private onExcite(): void {
    const checked = [...this.root.querySelectorAll<HTMLInputElement>('input[data-excite]')].filter((c) => c.checked).map((c) => c.dataset.excite!);
    const all = this.doc.ports.length === checked.length;
    this.store.set(['analysis', 'excite'], all ? undefined : checked);
  }

  /** After a rename the selection key changes for variables and materials. */
  private followRename(name: string): void {
    const s = this.selection;
    if (s.kind === 'variable' || s.kind === 'material') this.select(selectionKey({ ...s, name }));
  }

  private onAction(act: string, arg?: string): void {
    const s = this.selection;
    const update = (change: (doc: Project) => Project) => this.store.update((doc) => change(doc as Project));
    switch (act) {
      case 'goto':
        return this.select(arg!);
      case 'remove-variable':
        if (s.kind === 'variable') update((d) => actions.removeVariable(d, s.name)), this.select('project');
        return;
      case 'remove-material':
        if (s.kind === 'material') update((d) => actions.removeMaterial(d, s.name)), this.select('project');
        return;
      case 'move-layer-up':
      case 'move-layer-down':
        if (s.kind !== 'layer') return;
        update((d) => actions.moveLayer(d, s.index, act === 'move-layer-up' ? 1 : -1));
        return this.select(selectionKey({ kind: 'layer', index: Math.max(0, Math.min(this.doc.stackup.length - 1, s.index + (act === 'move-layer-up' ? 1 : -1))) }));
      case 'remove-layer':
        if (s.kind === 'layer') update((d) => actions.removeLayer(d, s.index)), this.select('project');
        return;
      case 'duplicate-shape':
        if (s.kind !== 'shape') return;
        {
          const { doc, index } = actions.duplicateShape(this.doc, s.layer, s.index);
          this.store.update(() => doc);
          return this.select(selectionKey({ kind: 'shape', layer: s.layer, index }));
        }
      case 'make-editable':
        if (s.kind !== 'shape') return;
        {
          const choice = (axis: 'x' | 'y') => (this.root.querySelector<HTMLSelectElement>(`#anchor-${axis}`)?.value ?? 'auto') as actions.AnchorChoice;
          const { doc, variables, notes } = actions.makeRectangleEditable(this.doc, s.layer, s.index, { x: choice('x'), y: choice('y') });
          const shapeId = this.doc.geometry[s.layer][s.index].id;
          this.store.update(() => doc);
          for (const note of notes) this.report(note.kind, `${shapeId}: ${note.text}.`);
          const first = variables.find((v) => !doc.variables[v].locked) ?? variables[0];
          if (first) return this.select(selectionKey({ kind: 'variable', name: first }));
          return;
        }
      case 'remove-shape':
        if (s.kind === 'shape') update((d) => actions.removeShape(d, s.layer, s.index)), this.select('project');
        return;
      case 'add-point':
      case 'remove-point': {
        const owner: actions.PolygonOwner | null = s.kind === 'shape' ? { layer: s.layer, shape: s.index } : s.kind === 'board' ? 'board' : null;
        if (owner) update((d) => (act === 'add-point' ? actions.addPoint(d, owner, Number(arg)) : actions.removePoint(d, owner, Number(arg))));
        return;
      }
      case 'remove-port':
        if (s.kind === 'port') update((d) => actions.removePort(d, s.index)), this.select('project');
        return;
      case 'remove-component':
        if (s.kind === 'component') update((d) => actions.removeComponent(d, s.index)), this.select('project');
        return;
      case 'remove-via':
        if (s.kind === 'via') update((d) => actions.removeVia(d, s.index)), this.select('project');
        return;
    }
  }
}

/** Input text to a JSON value. Text that isn't a number stays text, so the schema names the problem. */
function parseInput(kind: Kind, text: string, path: JsonPath): unknown {
  const trimmed = text.trim();
  if (kind === 'number' || kind === 'integer') {
    // A component leaves out a part whose value is cleared; the schema then asks for a connection only if it still needs one.
    if (trimmed === '' && ['r_ohm', 'l_nh', 'c_pf'].includes(String(path.at(-1)))) return undefined;
    const n = Number(trimmed);
    return trimmed !== '' && Number.isFinite(n) ? n : trimmed;
  }
  if (kind === 'numbers') {
    if (trimmed === '') return path.at(-1) === 'far_field_ghz' || path.at(-1) === 'near_field_mm' ? undefined : [];
    return trimmed.split(/[\s,;]+/).filter(Boolean).map((t) => (Number.isFinite(Number(t)) ? Number(t) : t));
  }
  // Optional keys disappear when cleared: range bounds, a component's width and connection.
  if (trimmed === '' && ['min', 'max', 'width', 'connection', 'antipad'].includes(String(path.at(-1)))) return undefined;
  return kind === 'length' ? trimmed : text;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** 12.4, 0.035, 1.5: as few digits as the value needs, at most 4 decimals. */
export function fmtMm(mm: number): string {
  return String(+mm.toFixed(4)).replace('-', '−');
}

/** A dielectric's fields: eps_r and tan_delta, and mu_r and its loss tangent when the material is magnetic. */
function dielectricFields(p: JsonPath, m: DielectricMaterial | undefined): Field[] {
  const model = m?.dispersion;
  // The document may be mid-edit, so the table's rows are not trusted to exist.
  const rows = model?.model === 'table' && Array.isArray(model.points) ? model.points : [];
  const epsHint = model?.model === 'table'
    ? `Shown for lists and exports only; the solver fits the material's ${rows.length}-row table${rows.length > 0 ? ` from ${rows[0]?.f_ghz} to ${rows[rows.length - 1]?.f_ghz} GHz` : ''}.`
    : model?.model === 'conductivity'
      ? 'Constant across the band; the loss is a conductivity, exact at the loss reference.'
      : model
        ? `The value at ${model.at_ghz} GHz; ${model.model === 'djordjevic_sarkar' ? 'the Djordjevic-Sarkar wideband model' : 'the material\'s Debye/Lorentz poles'} give the rest of the band.`
        : m && m.tan_delta > 0 ? 'The value at the loss reference; the Djordjevic-Sarkar wideband model gives the rest of the band.' : undefined;
  const fields: Field[] = [
    { label: 'Relative permittivity εr', path: [...p, 'eps_r'], kind: 'number', ...(epsHint ? { hint: epsHint } : {}) },
    { label: 'Loss tangent', path: [...p, 'tan_delta'], kind: 'number' },
  ];
  if (m?.mu_r !== undefined) {
    const muHint = m.mu_dispersion ? `The value at ${m.mu_dispersion.at_ghz} GHz; the material's poles give the rest of the band.` : undefined;
    fields.push(
      { label: 'Relative permeability μr', path: [...p, 'mu_r'], kind: 'number', ...(muHint ? { hint: muHint } : {}) },
      { label: 'Magnetic loss tangent', path: [...p, 'mu_tan_delta'], kind: 'number' },
    );
  }
  return fields;
}
