/**
 * What is selected in the project tree, as a short key ("port:0",
 * "shape:top:1"). Keys are stable across edits that don't add or remove
 * items, so the selection survives a re-render.
 */
export type Selection =
  | { kind: 'project' }
  | { kind: 'board' }
  | { kind: 'variables' }
  | { kind: 'variable'; name: string }
  | { kind: 'materials' }
  | { kind: 'material'; name: string }
  | { kind: 'stackup' }
  | { kind: 'layer'; index: number }
  | { kind: 'copper'; layer: string }
  | { kind: 'shape'; layer: string; index: number }
  | { kind: 'ports' }
  | { kind: 'port'; index: number }
  | { kind: 'components' }
  | { kind: 'component'; index: number }
  | { kind: 'vias' }
  | { kind: 'via'; index: number }
  | { kind: 'boundaries' }
  | { kind: 'mesh' }
  | { kind: 'analysis' };

export function selectionKey(s: Selection): string {
  switch (s.kind) {
    case 'variable':
    case 'material':
      return `${s.kind}:${s.name}`;
    case 'layer':
    case 'port':
    case 'component':
    case 'via':
      return `${s.kind}:${s.index}`;
    case 'copper':
      return `copper:${s.layer}`;
    case 'shape':
      return `shape:${s.layer}:${s.index}`;
    default:
      return s.kind;
  }
}

export function parseSelectionKey(key: string): Selection {
  const [kind, a, b] = key.split(':');
  switch (kind) {
    case 'variable':
    case 'material':
      return { kind, name: a };
    case 'layer':
    case 'port':
    case 'component':
    case 'via':
      return { kind, index: Number(a) };
    case 'copper':
      return { kind, layer: a };
    case 'shape':
      return { kind, layer: a, index: Number(b) };
    default:
      return { kind } as Selection;
  }
}

/** The tree item a schema error path belongs to, e.g. "$.geometry.top[1].polygon[0][1]" -> shape top/1. */
export function selectionForErrorPath(path: string): Selection {
  const m = (re: RegExp) => re.exec(path);
  let hit: RegExpExecArray | null;
  if ((hit = m(/^\$\.variables\.([A-Za-z0-9_]+)/))) return { kind: 'variable', name: hit[1] };
  if (path.startsWith('$.variables')) return { kind: 'variables' };
  // Material names may hold dots ("RT/duroid 6010.2LM"): only a known property name ends one.
  if ((hit = m(/^\$\.materials\.(.+?)(?:\.(?:kind|eps_r|tan_delta|conductivity_s_per_m|mu_r|mu_tan_delta|dispersion|mu_dispersion|roughness)(?:[.[].*)?)?$/))) return { kind: 'material', name: hit[1] };
  if (path.startsWith('$.materials')) return { kind: 'materials' };
  if ((hit = m(/^\$\.stackup\[(\d+)\]/))) return { kind: 'layer', index: Number(hit[1]) };
  if (path.startsWith('$.stackup')) return { kind: 'stackup' };
  if ((hit = m(/^\$\.geometry\.([A-Za-z0-9_-]+)\[(\d+)\]/))) return { kind: 'shape', layer: hit[1], index: Number(hit[2]) };
  if ((hit = m(/^\$\.geometry\.([A-Za-z0-9_-]+)/))) return { kind: 'copper', layer: hit[1] };
  if ((hit = m(/^\$\.ports\[(\d+)\]/))) return { kind: 'port', index: Number(hit[1]) };
  if (path.startsWith('$.ports')) return { kind: 'ports' };
  if ((hit = m(/^\$\.components\[(\d+)\]/))) return { kind: 'component', index: Number(hit[1]) };
  if (path.startsWith('$.components')) return { kind: 'components' };
  if ((hit = m(/^\$\.vias\[(\d+)\]/))) return { kind: 'via', index: Number(hit[1]) };
  if (path.startsWith('$.vias')) return { kind: 'vias' };
  if (path.startsWith('$.board')) return { kind: 'board' };
  if (path.startsWith('$.boundaries')) return { kind: 'boundaries' };
  if (path.startsWith('$.mesh')) return { kind: 'mesh' };
  if (path.startsWith('$.analysis') || path.startsWith('$.outputs')) return { kind: 'analysis' };
  return { kind: 'project' };
}
