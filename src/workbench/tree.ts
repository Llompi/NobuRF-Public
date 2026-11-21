/**
 * The project tree: every part of the project file, grouped as the file
 * groups it. Built from the document (not the parsed project), so it still
 * shows everything while an edit is invalid; the item with the error gets a
 * marker.
 */
import type { ComponentValue, DielectricMaterial, Project } from '../project/schema';
import { escapeHtml } from '../ui/format';
import { selectionForErrorPath, selectionKey } from './selection';
import type { ProjectStore } from './store';

interface Item {
  key: string;
  label: string;
  detail?: string;
  /** Rendered as a small swatch before the label (copper, dielectric, port). */
  swatch?: 'copper' | 'dielectric' | 'port' | 'component' | 'cut' | 'outline';
  /** Left out of the group's count. */
  uncounted?: boolean;
}

interface Group {
  key: string;
  label: string;
  items: Item[];
  /** Nested groups, e.g. one per copper layer. */
  children?: Group[];
  /** "Add ..." row at the end of the group. */
  add?: { action: string; label: string };
}

const entries = <T>(o: Record<string, T> | undefined) => (o && typeof o === 'object' ? Object.entries(o) : []);
const list = <T>(a: T[] | undefined) => (Array.isArray(a) ? a : []);

function groups(doc: Partial<Project>, store: ProjectStore): Group[] {
  const resolved = store.lastValid?.resolved;
  const variables = entries(doc.variables).map(([name, v]): Item => {
    const q = resolved?.variables[name];
    const value = q ? (q.dim === 1 ? `${+q.value.toPrecision(6)} mm` : `${+q.value.toPrecision(6)}`) : v?.value;
    // An unlocked length is one the AI tuner may change; flag a missing limit, which it would otherwise assume.
    const missing = !v?.locked && q?.dim === 1 ? [v?.min === undefined ? 'min' : '', v?.max === undefined ? 'max' : ''].filter(Boolean) : [];
    const detail = v?.locked ? `${value}, locked` : missing.length ? `${value}, no ${missing.join(' or ')}` : value;
    return { key: selectionKey({ kind: 'variable', name }), label: name, detail };
  });
  const materials = entries(doc.materials).map(([name, m]): Item => ({
    key: selectionKey({ kind: 'material', name }),
    label: name,
    // A table-only dielectric has no eps_r in the file; only a conductor has a conductivity.
    detail: 'conductivity_s_per_m' in (m ?? {}) ? 'conductor' : dielectricDetail(m as DielectricMaterial),
    swatch: 'conductivity_s_per_m' in (m ?? {}) ? 'copper' : 'dielectric',
  }));
  // Stackup listed top first, as a cross-section reads; indices stay those of the file.
  const stackup = list(doc.stackup).map((layer, index): Item => ({
    key: selectionKey({ kind: 'layer', index }),
    label: layer?.name ?? `layer ${index + 1}`,
    detail: layer?.type === 'dielectric' ? `${layer.material}, ${layer.thickness}` : layer?.material,
    swatch: layer?.type === 'copper' ? 'copper' : 'dielectric',
  })).reverse();
  // The outline bounds every dielectric layer, so it is listed with them; it is not a layer, so it is not counted.
  const outline: Item = { key: 'board', label: 'Board outline', detail: `${list(doc.board?.outline).length} points`, swatch: 'outline', uncounted: true };
  const copperLayers: Group[] = list(doc.stackup).filter((l) => l?.type === 'copper').reverse().map((layer) => ({
    key: selectionKey({ kind: 'copper', layer: layer.name }),
    label: layer.name,
    add: { action: `add-shape:${layer.name}`, label: 'Add rectangle' },
    items: list(doc.geometry?.[layer.name]).map((shape, index): Item => ({
      key: selectionKey({ kind: 'shape', layer: layer.name, index }),
      label: shape?.id ?? `shape ${index + 1}`,
      detail: shape?.op === 'cut' ? 'cut' : `${list(shape?.polygon).length} points`,
      swatch: shape?.op === 'cut' ? 'cut' : 'copper',
    })),
  }));
  const ports = list(doc.ports).map((port, index): Item => ({
    key: selectionKey({ kind: 'port', index }),
    label: port?.id ?? `port ${index + 1}`,
    detail: `${index + 1}, ${port?.reference_impedance_ohm} Ω`,
    swatch: 'port',
  }));
  const components = list(doc.components).map((component, index): Item => ({
    key: selectionKey({ kind: 'component', index }),
    label: component?.id ?? `component ${index + 1}`,
    detail: component ? componentValueText(component) : undefined,
    swatch: 'component',
  }));
  const vias = list(doc.vias).map((via, index): Item => ({
    key: selectionKey({ kind: 'via', index }),
    label: via?.id ?? `via ${index + 1}`,
    detail: via ? `${via.to === undefined ? '' : 'fence, '}${via.drill}` : undefined,
    swatch: 'copper',
  }));
  return [
    { key: 'variables', label: 'Variables', items: variables, add: { action: 'add-variable', label: 'Add variable' } },
    { key: 'materials', label: 'Materials', items: materials, add: { action: 'add-material', label: 'Add material' } },
    { key: 'stackup', label: 'Stackup', items: [...stackup, outline], add: { action: 'add-layer', label: 'Add layer pair on top' } },
    { key: 'geometry', label: 'Copper', items: [], children: copperLayers },
    { key: 'ports', label: 'Ports', items: ports, add: { action: 'add-port', label: 'Add port' } },
    { key: 'components', label: 'Components', items: components, add: { action: 'add-component', label: 'Add component' } },
    { key: 'vias', label: 'Vias', items: vias, add: { action: 'add-via', label: 'Add via' } },
    { key: 'setup', label: 'Setup', items: [
      { key: 'boundaries', label: 'Boundaries' },
      { key: 'mesh', label: 'Mesh' },
      { key: 'analysis', label: 'Analysis and outputs' },
    ] },
  ];
}

/** "50 Ω", "2.2 nH ∥ 1 pF": a component's value as a schematic would label it. */
export function componentValueText(c: ComponentValue): string {
  const parts = [
    c.r_ohm === undefined ? null : `${c.r_ohm} Ω`,
    c.l_nh === undefined ? null : `${c.l_nh} nH`,
    c.c_pf === undefined ? null : `${c.c_pf} pF`,
  ].filter((p) => p !== null);
  return parts.join(c.connection === 'parallel' ? ' ∥ ' : ' + ');
}

export class ProjectTree {
  private selected = 'project';
  /** Groups the user closed; everything starts open. */
  private closed = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly store: ProjectStore,
    private readonly onSelect: (key: string) => void,
    private readonly onAction: (action: string) => void,
  ) {
    root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-key], button[data-action]');
      if (button?.dataset.key) this.select(button.dataset.key);
      else if (button?.dataset.action) this.onAction(button.dataset.action);
    });
    root.addEventListener('toggle', (event) => {
      const details = event.target as HTMLDetailsElement;
      if (details.dataset.group) details.open ? this.closed.delete(details.dataset.group) : this.closed.add(details.dataset.group);
    }, true);
    root.addEventListener('keydown', (event) => this.onKey(event));
  }

  get selection(): string {
    return this.selected;
  }

  select(key: string): void {
    this.selected = key;
    this.render();
    this.onSelect(key);
  }

  /** Up and down move through the visible items, as in any tree. */
  private onKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button[data-key]')].filter((b) => b.offsetParent !== null);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    event.preventDefault();
    next.focus();
    this.select(next.dataset.key!);
    next.focus();
  }

  render(): void {
    const doc = (this.store.document ?? {}) as Partial<Project>;
    const error = this.store.validation.error;
    const errorKey = error ? selectionKey(selectionForErrorPath(error.path)) : null;
    const focusedKey = (document.activeElement as HTMLElement | null)?.closest?.('#tree') ? (document.activeElement as HTMLElement).dataset.key : undefined;
    const item = (it: Item) => {
      const current = it.key === this.selected;
      const bad = it.key === errorKey;
      return `<li><button type="button" data-key="${escapeHtml(it.key)}"${current ? ' aria-current="true"' : ''}>` +
        (it.swatch ? `<span class="swatch ${it.swatch}" aria-hidden="true"></span>` : '') +
        `<span class="item-label">${escapeHtml(it.label)}</span>` +
        (it.detail ? `<span class="item-detail">${escapeHtml(String(it.detail))}</span>` : '') +
        (bad ? '<span class="item-error">Error</span>' : '') +
        '</button></li>';
    };
    const group = (g: Group): string => {
      const open = !this.closed.has(g.key);
      const add = g.add ? `<li><button type="button" class="add" data-action="${escapeHtml(g.add.action)}">${escapeHtml(g.add.label)}</button></li>` : '';
      const bad = g.key === errorKey ? '<span class="item-error">Error</span>' : '';
      const count = g.items.filter((it) => !it.uncounted).length + (g.children?.reduce((n, c) => n + c.items.length, 0) ?? 0);
      return `<details data-group="${escapeHtml(g.key)}"${open ? ' open' : ''}>` +
        `<summary><span class="group-label">${escapeHtml(g.label)}</span><span class="count">${count}</span>${bad}</summary>` +
        `<ul>${g.items.map(item).join('')}${add}</ul>` +
        (g.children ?? []).map((c) => `<div class="subgroup">${group(c)}</div>`).join('') +
        '</details>';
    };
    const name = typeof doc.name === 'string' ? doc.name : 'Untitled';
    this.root.innerHTML =
      `<button type="button" class="project-root" data-key="project"${this.selected === 'project' ? ' aria-current="true"' : ''}>` +
      `<span class="item-label">${escapeHtml(name)}</span>${errorKey === 'project' ? '<span class="item-error">Error</span>' : ''}</button>` +
      groups(doc, this.store).map(group).join('');
    if (focusedKey) this.root.querySelector<HTMLButtonElement>(`button[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
  }
}


/** "εr 4.4", with the permeability and "wideband" or "poles" when the material has them. */
function dielectricDetail(m: DielectricMaterial): string {
  const parts = [`εr ${m.eps_r}`];
  if (m.mu_r !== undefined && m.mu_r !== 1) parts.push(`μr ${m.mu_r}`);
  if (m.dispersion || m.mu_dispersion) parts.push(m.dispersion?.model === 'djordjevic_sarkar' ? 'wideband' : m.dispersion?.model === 'table' ? 'table' : 'poles');
  return parts.join(', ');
}
