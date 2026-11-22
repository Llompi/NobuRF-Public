/**
 * Import copper or a board outline from a Gerber, DXF or STEP file into the
 * open project: the browser side of `noburf import` (src/import/command.ts).
 * The open project is the template; mergeImported replaces the chosen
 * layer's shapes or the outline, and the result is validated.
 */
import type { Vec2 } from '../project/resolve';
import type { Project } from '../project/schema';
import { dxfLayerOutline, dxfLayerShapes, parseDxf } from '../import/dxf';
import { boundingBox, translatePolygon, type ImportedShape } from '../import/geometry';
import { drillVias, parseExcellon } from '../import/excellon';
import { gerberOutline, parseGerber } from '../import/gerber';
import { mergeImported } from '../import/project';
import { resolveProject, type ResolvedProject } from '../project/resolve';
import { parseProject } from '../project/schema';
import { describeBodies, parseStep, stepCopper, stepOutline, type StepModel } from '../import/step';
import { byId } from '../ui/dom';
import { escapeHtml } from '../ui/format';
import { portlessView } from './portless_view';
import type { ProjectStore } from './store';

type Kind = 'gerber' | 'dxf' | 'step' | 'drill';
const OUTLINE = '@outline';
const DRILL = '@drill';

function kindOf(name: string): Kind {
  if (/\.(drl|xln|exc|drd)$/i.test(name)) return 'drill';
  if (/\.dxf$/i.test(name)) return 'dxf';
  if (/\.(step|stp)$/i.test(name)) return 'step';
  return 'gerber';
}

/**
 * Why a file taken for Gerber (any extension but DXF and STEP is) is not one, or null when it may be.
 * Every Gerber file sets its coordinate format (%FS); without it the parser's first complaint is about
 * syntax, which says nothing to someone who picked the wrong file.
 */
function notGerber(name: string, text: string): string | null {
  // The parser drops line breaks inside extended commands and splits %MOMM*FSLAX46Y46*% at the stars.
  if (/[%*]FS[LT]/.test(text.replace(/\s+/g, ''))) return null;
  if (/^\s*\{/.test(text) && text.includes('"noburf_project"')) return `${name} is a NobuRF project. Open it with Open; Import takes Gerber, DXF and STEP files.`;
  return `${name} is not a Gerber, DXF or STEP file: it has no Gerber format statement (%FS).`;
}

const range = (low: number, high: number) => `${+low.toFixed(2)} to ${+high.toFixed(2)} mm`;

/**
 * Copper that lies wholly outside the board outline after an import, said as a warning, or null. Files keep
 * the exporter's coordinates (KiCad's page sits near x 100, y -50 mm), so copper imported without its outline
 * often lands off a new board, and a solve then drops it with only a mesh warning. A copper import checks the
 * layer it filled; an outline import checks every layer, since the copper drawn for the old outline stays put.
 */
function copperOffBoard(project: Project, importedLayer: string | null): string | null {
  let resolved: ResolvedProject | null;
  try {
    resolved = project.ports.length ? resolveProject(parseProject(project)) : portlessView(project);
  } catch {
    return null; // The store reports what is wrong with the project.
  }
  if (!resolved) return null;
  const board = boundingBox([resolved.boardOutline]);
  const outside = Object.entries(resolved.copper).flatMap(([layer, shapes]) => {
    if (importedLayer !== null && layer !== importedLayer) return [];
    const added = shapes.filter((s) => s.op === 'add').map((s) => s.polygon);
    if (!added.length) return [];
    const box = boundingBox(added);
    const overlaps = box.minX <= board.maxX && box.maxX >= board.minX && box.minY <= board.maxY && box.maxY >= board.minY;
    return overlaps ? [] : [`layer ${layer} (x ${range(box.minX, box.maxX)}, y ${range(box.minY, box.maxY)})`];
  });
  if (!outside.length) return null;
  const where = `is outside the board outline (x ${range(board.minX, board.maxX)}, y ${range(board.minY, board.maxY)}), so a solve leaves it out.`;
  return importedLayer !== null
    ? `The copper on ${outside[0]} ${where} Import the board outline from the same design with its coordinates kept, or import again with Position set to "Center on the origin".`
    : `The copper on ${outside.join(' and ')} ${where} Copper drawn for the old outline, such as a ground plane, stays where it was: import that layer from the same design, or redraw it.`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export class ImportDialog {
  private file: { name: string; text: string; kind: Kind; step?: StepModel } | null = null;
  private reading = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly report: (kind: 'info' | 'warning' | 'error', text: string) => void,
  ) {
    const dialog = byId<HTMLDialogElement>('import-dialog');
    byId('import').addEventListener('click', () => this.open());
    byId('import-cancel').addEventListener('click', () => dialog.close());
    byId<HTMLInputElement>('import-file').addEventListener('change', (e) => this.onFile((e.target as HTMLInputElement).files?.[0]));
    byId('import-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.apply();
    });
  }

  private open(): void {
    const doc = this.store.document as Project;
    const copper = (doc.stackup ?? []).filter((l) => l?.type === 'copper').map((l) => l.name).reverse();
    byId<HTMLSelectElement>('import-target').innerHTML =
      copper.map((name) => `<option value="${escapeHtml(name)}">Copper layer ${escapeHtml(name)}</option>`).join('') +
      `<option value="${OUTLINE}">Board outline</option>` +
      `<option value="${DRILL}">Plated holes (Excellon drill file)</option>`;
    // Each import starts clean: a file or error from the last one must not carry over.
    this.file = null;
    this.reading = false;
    byId<HTMLInputElement>('import-file').value = '';
    byId('import-dxf-row').hidden = true;
    byId('import-step-row').hidden = true;
    byId('import-step-bodies-list').textContent = '';
    byId('import-error').hidden = true;
    byId<HTMLDialogElement>('import-dialog').showModal();
  }

  private async onFile(file: File | undefined): Promise<void> {
    byId('import-error').hidden = true;
    this.file = null; // Until the new file is read, Import must not use the previous one.
    this.reading = file !== undefined;
    // A slower read of an earlier choice must not replace a later one, nor show its error over it.
    const superseded = () => file !== byId<HTMLInputElement>('import-file').files?.[0];
    let text: string;
    try {
      text = file ? await file.text() : '';
    } catch (error) {
      if (superseded()) return;
      this.reading = false;
      return this.showError(`Could not read ${file!.name}: ${(error as Error).message}`);
    }
    if (superseded()) return;
    this.reading = false;
    // A .txt may be an NC drill file (Altium, EAGLE) or a Gerber: an Excellon file starts with its M48 header.
    const detected: Kind = file && /\.txt$/i.test(file.name) && /^\s*(;[^\n]*\n\s*)*M48\b/.test(text) ? 'drill' : file ? kindOf(file.name) : 'gerber';
    this.file = file ? { name: file.name, text, kind: detected } : null;
    const kind = this.file?.kind;
    byId('import-dxf-row').hidden = kind !== 'dxf';
    byId('import-step-row').hidden = kind !== 'step';
    byId('import-step-bodies-list').textContent = '';
    if (kind === 'gerber') {
      const problem = notGerber(this.file!.name, text);
      if (problem) this.showError(problem);
    } else if (kind === 'step') {
      // Body names come from the exporter, so list them: the selector is typed from this, not guessed.
      try {
        this.file!.step = parseStep(this.file!.text, this.file!.name);
        byId('import-step-bodies-list').textContent = describeBodies(this.file!.step);
      } catch (error) {
        this.showError((error as Error).message);
      }
    } else if (kind === 'dxf') {
      try {
        const layers = [...new Set(parseDxf(this.file!.text, this.file!.name).entities.map((e) => e.layer))].sort();
        byId<HTMLSelectElement>('import-dxf-layer').innerHTML = layers.map((l) => `<option>${escapeHtml(l)}</option>`).join('');
      } catch (error) {
        this.showError((error as Error).message);
      }
    }
  }

  /**
   * Plated holes as vias through the whole stackup, added to the project's vias: a board may come as several
   * drill files (Altium writes round holes and slots apart). Undo takes an import back.
   */
  private applyDrill(name: string, text: string, origin: string): void {
    try {
      if (origin !== 'keep') return this.showError('Import plated holes with Position set to keep the file\'s coordinates, so they land on the copper imported the same way.');
      const doc = this.store.document as Project;
      const copper = (doc.stackup ?? []).filter((l) => l?.type === 'copper').map((l) => l.name);
      if (copper.length < 2) return this.showError('Plated holes need at least two copper layers to join.');
      // Number on from the highest drill-<n> name in use anywhere, so no id clashes with an earlier import or a part.
      const names = [...doc.ports, ...(doc.components ?? []), ...(doc.vias ?? [])].map((p) => /^drill-(\d+)$/.exec(p.id)).filter((m) => m !== null);
      const firstNumber = Math.max(0, ...names.map((m) => Number(m[1]))) + 1;
      const made = drillVias(parseExcellon(text, name), [copper[0], copper.at(-1)!], copper.length, name, firstNumber);
      // A hole already in the project (the same file imported again) is not added twice: two barrels on one
      // place would share grid edges and stop the solve.
      const place = (v: { x: string; y: string; drill: string; to?: [string, string] }) => JSON.stringify([v.x, v.y, v.drill, v.to ?? null]);
      const present = new Set((doc.vias ?? []).map(place));
      const vias = made.vias.filter((v) => !present.has(place(v))).map((v, n) => ({ ...v, id: `drill-${firstNumber + n}` }));
      const repeated = made.vias.length - vias.length;
      if (vias.length === 0) return this.showError(`Every plated hole in ${name} is already in the project.`);
      const skipped = made.skipped;
      const earlier = (doc.vias ?? []).filter((v) => /^drill-\d+$/.test(v.id)).length;
      const project = { ...doc, vias: [...(doc.vias ?? []), ...vias] };
      // The same checks as a copper import: only a missing port (a new board) may pass, and with ports the resolver
      // must accept the vias too (it refuses them alongside SMA and coax-probe ports, for one).
      try {
        const parsed = parseProject(project);
        resolveProject(parsed);
      } catch (error) {
        if (!(project.ports.length === 0 && /^\$\.ports: needs at least one port/.test((error as Error).message))) throw error;
      }
      this.store.update(() => project);
      byId<HTMLDialogElement>('import-dialog').close();
      const slots = vias.filter((v) => v.to).length;
      this.report('info', `Imported ${plural(vias.length, 'plated hole', 'plated holes')} from ${name} as vias from ${copper[0]} to ${copper.at(-1)}` +
        `${slots ? `, ${plural(slots, 'slot', 'slots')} as a via at each end` : ''}` +
        `${skipped ? `; left out ${plural(skipped, 'non-plated hole', 'non-plated holes')}` : ''}` +
        `${repeated ? `; ${plural(repeated, 'hole was', 'holes were')} already in the project` : ''}` +
        `${earlier ? `. They are added to the ${plural(earlier, 'plated hole', 'plated holes')} imported before; Undo takes this import back` : ''}.`);
    } catch (error) {
      this.showError((error as Error).message);
    }
  }

  private showError(text: string): void {
    const el = byId('import-error');
    el.textContent = text;
    el.hidden = false;
  }

  private apply(): void {
    const file = this.file;
    if (!file) return this.showError(this.reading ? 'Still reading the file. Try again in a moment.' : 'Choose a file first.');
    const target = byId<HTMLSelectElement>('import-target').value;
    const origin = byId<HTMLSelectElement>('import-origin').value;
    if ((file.kind === 'drill') !== (target === DRILL)) {
      return this.showError(file.kind === 'drill'
        ? `${file.name} is a drill file: choose "Plated holes" as what it imports into.`
        : 'Plated holes come from an Excellon drill file (.drl), not a copper or outline file.');
    }
    if (file.kind === 'drill') return this.applyDrill(file.name, file.text, origin);
    try {
      const asOutline = target === OUTLINE;
      let shapes: ImportedShape[] = [];
      let outline: Vec2[] | undefined;
      if (file.kind === 'gerber') {
        const problem = notGerber(file.name, file.text);
        if (problem) return this.showError(problem);
        const image = parseGerber(file.text, file.name);
        if (asOutline) outline = gerberOutline(image, file.name);
        else shapes = image.shapes;
      } else if (file.kind === 'dxf') {
        const drawing = parseDxf(file.text, file.name);
        const layer = byId<HTMLSelectElement>('import-dxf-layer').value;
        if (asOutline) outline = dxfLayerOutline(drawing, layer);
        else shapes = dxfLayerShapes(drawing, layer);
      } else {
        const model = file.step ?? parseStep(file.text, file.name);
        const selector = byId<HTMLInputElement>('import-step-bodies').value.trim();
        if (!selector) return this.showError('Name the STEP bodies to import, by name ("*_PCB") or by height ("@1.6mm..1.635mm").');
        if (asOutline) outline = stepOutline(model, selector).outline;
        else shapes = stepCopper(model, selector).shapes;
      }
      // Origin: keep the file's coordinates, or move what is imported so its bounding box is centered on (0, 0) or starts there.
      const polygons = outline ? [outline] : shapes.map((s) => s.polygon);
      let shift: Vec2 = [0, 0];
      if (origin !== 'keep' && polygons.length) {
        const box = boundingBox(polygons);
        shift = origin === 'center' ? [-(box.minX + box.maxX) / 2, -(box.minY + box.maxY) / 2] : [-box.minX, -box.minY];
      }
      const moved = shapes.map((s) => ({ ...s, polygon: translatePolygon(s.polygon, shift) }));
      const project = mergeImported(this.store.document,
        asOutline ? [] : [{ layerName: target, sourceName: file.name, shapes: moved }],
        outline && translatePolygon(outline, shift)) as unknown as Project;
      // Import into a board that has no port yet (a new blank board) is the usual start; any other problem refuses the import.
      try {
        parseProject(project);
      } catch (error) {
        if (!(project.ports.length === 0 && /^\$\.ports: needs at least one port/.test((error as Error).message))) throw error;
      }
      this.store.update(() => project);
      byId<HTMLDialogElement>('import-dialog').close();
      this.report('info', asOutline
        ? `Imported the board outline from ${file.name}: ${project.board.outline.length} points.`
        : `Imported ${plural(project.geometry[target].length, 'copper shape', 'copper shapes')} from ${file.name} onto layer ${target}.${project.ports.length ? ' Check that the ports still sit on copper.' : ''}`);
      // After the summary, so the newest message, on top, is the one to act on.
      const offBoard = copperOffBoard(project, asOutline ? null : target);
      if (offBoard) this.report('warning', offBoard);
    } catch (error) {
      this.showError((error as Error).message);
    }
  }
}
