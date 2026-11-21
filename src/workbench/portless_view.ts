import { resolveProject, type ResolvedProject } from '../project/resolve';
import { parseProject, type Project } from '../project/schema';

/**
 * A board with no port yet (a new blank board) fails validation only for
 * that, but should still be shown, so copper can be drawn or imported onto
 * it: resolved with a stand-in port, which is then left out.
 */
export function portlessView(doc: unknown): ResolvedProject | null {
  const project = doc as Project;
  if (!Array.isArray(project?.ports) || project.ports.length > 0 || !Array.isArray(project.stackup)) return null;
  const copper = project.stackup.filter((l) => l.type === 'copper').map((l) => l.name);
  if (copper.length < 2) return null;
  try {
    const withPort = { ...project, ports: [{ id: 'view', x: '0 mm', y: '0 mm', between: [copper[0], copper[1]], reference_impedance_ohm: 50 }], analysis: { ...project.analysis, excite: undefined } };
    return { ...resolveProject(parseProject(withPort)), ports: [], excite: [] };
  } catch {
    return null;
  }
}
