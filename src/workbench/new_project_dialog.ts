/**
 * "New": a project from a template (new_project.ts), sized from the design
 * frequency and the laminate. The board size fields show the automatic size
 * as their placeholder; a typed value overrides it.
 */
import { BUILTIN_MATERIALS, type Project } from '../project/schema';
import { byId } from '../ui/dom';
import { escapeHtml } from '../ui/format';
import { isConductor, MATERIAL_LIBRARY } from './material_library';
import { defaultBoardMm, newProject, type Template } from './new_project';

export class NewProjectDialog {
  private readonly dialog = byId<HTMLDialogElement>('new-dialog');

  constructor(private readonly open: (project: Project) => void) {
    const builtin = Object.entries(BUILTIN_MATERIALS).filter(([n, m]) => m.kind === 'dielectric' && n !== 'air').map(([n]) => n);
    const library = MATERIAL_LIBRARY.filter((m) => !isConductor(m));
    byId<HTMLSelectElement>('new-substrate').innerHTML =
      `<optgroup label="Built in">${builtin.map((n) => `<option>${escapeHtml(n)}</option>`).join('')}</optgroup>` +
      `<optgroup label="Library">${library.map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(`${m.name}  εr ${'eps_r' in m ? m.eps_r : ''}`)}</option>`).join('')}</optgroup>`;
    byId('new').addEventListener('click', () => this.show());
    byId('new-cancel').addEventListener('click', () => this.dialog.close());
    byId('new-form').addEventListener('input', () => this.updatePlaceholders());
    byId('new-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.create();
    });
  }

  private show(): void {
    byId('new-error').hidden = true;
    this.updatePlaceholders();
    this.dialog.showModal();
  }

  private read() {
    const number = (id: string) => Number(byId<HTMLInputElement>(id).value.trim().replace(',', '.'));
    const optional = (id: string) => (byId<HTMLInputElement>(id).value.trim() ? number(id) : undefined);
    return {
      template: (this.dialog.querySelector<HTMLInputElement>('input[name="new-template"]:checked')?.value ?? 'patch') as Template,
      name: byId<HTMLInputElement>('new-name').value.trim() || 'untitled',
      frequencyGHz: number('new-frequency'),
      substrate: byId<HTMLSelectElement>('new-substrate').value,
      thicknessMm: number('new-thickness'),
      boardWMm: optional('new-board-w'),
      boardLMm: optional('new-board-l'),
    };
  }

  /** Shows the automatic board size while the size fields are empty. */
  private updatePlaceholders(): void {
    const spec = this.read();
    let auto = { w: NaN, l: NaN };
    if (spec.frequencyGHz > 0 && spec.thicknessMm > 0) auto = defaultBoardMm(spec);
    byId<HTMLInputElement>('new-board-w').placeholder = Number.isFinite(auto.w) ? `Auto, ${auto.w}` : '';
    byId<HTMLInputElement>('new-board-l').placeholder = Number.isFinite(auto.l) ? `Auto, ${auto.l}` : '';
  }

  private create(): void {
    const spec = this.read();
    const error = byId('new-error');
    const problem = !(spec.frequencyGHz > 0) ? 'Enter a design frequency above 0 GHz.'
      : !(spec.thicknessMm > 0) ? 'Enter a substrate thickness above 0 mm.'
      : (spec.boardWMm !== undefined && !(spec.boardWMm > 0)) || (spec.boardLMm !== undefined && !(spec.boardLMm > 0)) ? 'A board size must be above 0 mm, or left empty.'
      : null;
    try {
      if (problem) throw new Error(problem);
      const project = newProject(spec);
      this.dialog.close();
      this.open(project);
    } catch (e) {
      error.textContent = (e as Error).message;
      error.hidden = false;
    }
  }
}
