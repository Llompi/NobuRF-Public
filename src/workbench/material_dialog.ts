/**
 * "Add material": pick from the library (material_library.ts) or start a
 * custom dielectric or metal. A library pick is copied into the project, so
 * the file stays self-contained.
 */
import { BUILTIN_MATERIALS, type Project } from '../project/schema';
import { byId } from '../ui/dom';
import { escapeHtml } from '../ui/format';
import * as actions from './doc_actions';
import { isConductor, MATERIAL_LIBRARY, type LibraryMaterial } from './material_library';
import type { ProjectStore } from './store';

const fmtSiemens = (s: number) => `${(s / 1e7).toFixed(s >= 1e7 ? 2 : 3)} × 10⁷ S/m`;

export class MaterialDialog {
  private readonly dialog = byId<HTMLDialogElement>('material-dialog');

  constructor(
    private readonly store: ProjectStore,
    /** Selects the new material in the tree. */
    private readonly select: (name: string) => void,
  ) {
    byId('material-search').addEventListener('input', () => this.renderList());
    byId('material-cancel').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-material], button[data-custom]');
      if (!button) return;
      const doc = this.store.document as Project;
      if (button.dataset.material) {
        const name = button.dataset.material;
        this.store.update(() => actions.useLibraryMaterial(doc, name));
        this.dialog.close();
        this.select(name);
      } else {
        const { doc: next, name } = actions.addMaterial(doc, button.dataset.custom as 'dielectric' | 'conductor');
        this.store.update(() => next);
        this.dialog.close();
        this.select(name);
      }
    });
  }

  open(): void {
    byId<HTMLInputElement>('material-search').value = '';
    this.renderList();
    this.dialog.showModal();
  }

  private renderList(): void {
    const query = byId<HTMLInputElement>('material-search').value.trim().toLowerCase();
    const doc = this.store.document as Project;
    const have = (name: string) => Object.hasOwn(doc.materials ?? {}, name) || Object.hasOwn(BUILTIN_MATERIALS, name);
    const matches = MATERIAL_LIBRARY.filter((m) => !query || `${m.name} ${m.group} ${m.source}`.toLowerCase().includes(query));
    const groups = [...new Set(matches.map((m) => m.group))];
    const row = (m: LibraryMaterial) => {
      const values = isConductor(m) ? fmtSiemens(m.conductivity_s_per_m) : `εr ${m.eps_r}, tan δ ${m.tan_delta}`;
      const action = have(m.name)
        ? '<span class="material-have">In project</span>'
        : `<button type="button" data-material="${escapeHtml(m.name)}" aria-label="Add ${escapeHtml(m.name)}">Add</button>`;
      return `<li><div><span class="material-name">${escapeHtml(m.name)}</span><span class="material-values number">${escapeHtml(values)}</span>` +
        `<span class="material-source">${escapeHtml(m.source)}</span></div>${action}</li>`;
    };
    byId('material-list').innerHTML = groups.length
      ? groups.map((g) => `<h3>${escapeHtml(g)}</h3><ul>${matches.filter((m) => m.group === g).map(row).join('')}</ul>`).join('')
      : `<p class="note">Nothing in the library matches “${escapeHtml(query)}”. Add a custom material below.</p>`;
  }
}
