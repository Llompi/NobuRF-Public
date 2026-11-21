import type { Quantity } from './expression';
import { resolveProject } from './resolve';
import {
  fail, parseProject, readId, readLength, readObject, readShape, readString, type CopperShape, type Length, type Project,
} from './schema';

/**
 * Small named edits to a project document. Each one is validated (the edited
 * document must parse) and returns its exact inverse, so an undo stack is a
 * list of edits. Locked variables cannot be changed.
 */
export type ProjectEdit =
  | { op: 'set_variable'; name: string; value: string }
  /** Insert a shape at `index` in its layer's paint order (default: on top, painted last). */
  | { op: 'add_polygon'; layer: string; shape: CopperShape; index?: number }
  | { op: 'remove_polygon'; id: string }
  | { op: 'move_port'; id: string; x: Length; y: Length };

export interface EditResult {
  project: Project;
  /** Applying this to `project` restores the input. */
  undo: ProjectEdit;
}

function readEdit(v: unknown): ProjectEdit {
  const op = readObject(v, 'edit', ['op'], ['name', 'value', 'layer', 'shape', 'index', 'id', 'x', 'y']).op;
  switch (op) {
    case 'set_variable': {
      const o = readObject(v, 'edit', ['op', 'name', 'value']);
      return { op, name: readString(o.name, 'edit.name'), value: readString(o.value, 'edit.value') };
    }
    case 'add_polygon': {
      const o = readObject(v, 'edit', ['op', 'layer', 'shape'], ['index']);
      const edit: ProjectEdit = { op, layer: readString(o.layer, 'edit.layer'), shape: readShape(o.shape, 'edit.shape') };
      if (o.index !== undefined) {
        if (!Number.isInteger(o.index) || (o.index as number) < 0) fail('edit.index', `must be a non-negative integer, got ${JSON.stringify(o.index)}`);
        edit.index = o.index as number;
      }
      return edit;
    }
    case 'remove_polygon': {
      const o = readObject(v, 'edit', ['op', 'id']);
      return { op, id: readId(o.id, 'edit.id') };
    }
    case 'move_port': {
      const o = readObject(v, 'edit', ['op', 'id', 'x', 'y']);
      return { op, id: readId(o.id, 'edit.id'), x: readLength(o.x, 'edit.x'), y: readLength(o.y, 'edit.y') };
    }
    default:
      fail('edit.op', `must be set_variable, add_polygon, remove_polygon or move_port, got ${JSON.stringify(op)}`);
  }
}

/** Apply one edit (JSON from a file, the UI or an agent). The input project is not mutated. */
export function applyProjectEdit(project: Project, input: unknown): EditResult {
  const edit = readEdit(input);
  const doc = structuredClone(project);
  let undo: ProjectEdit;
  switch (edit.op) {
    case 'set_variable': {
      const variable = Object.hasOwn(doc.variables, edit.name) ? doc.variables[edit.name] : undefined;
      if (!variable) fail('edit.name', `no variable "${edit.name}"`);
      if (variable.locked) fail('edit.name', `variable "${edit.name}" is locked`);
      undo = { op: 'set_variable', name: edit.name, value: variable.value };
      variable.value = edit.value;
      break;
    }
    case 'add_polygon': {
      const shapes = Object.hasOwn(doc.geometry, edit.layer) ? doc.geometry[edit.layer] : undefined;
      if (!shapes) fail('edit.layer', `no copper layer "${edit.layer}"`);
      const index = edit.index ?? shapes.length;
      if (index > shapes.length) fail('edit.index', `${index} is past the end of layer "${edit.layer}" (${shapes.length} shapes)`);
      shapes.splice(index, 0, edit.shape);
      undo = { op: 'remove_polygon', id: edit.shape.id };
      break;
    }
    case 'remove_polygon': {
      const found = Object.entries(doc.geometry)
        .map(([layer, shapes]) => ({ layer, shapes, index: shapes.findIndex((s) => s.id === edit.id) }))
        .find((f) => f.index >= 0);
      if (!found) fail('edit.id', `no shape "${edit.id}"`);
      const [shape] = found.shapes.splice(found.index, 1);
      undo = { op: 'add_polygon', layer: found.layer, shape, index: found.index };
      break;
    }
    case 'move_port': {
      const port = doc.ports.find((p) => p.id === edit.id);
      if (!port) fail('edit.id', `no port "${edit.id}"`);
      if (port.kind === 'sma_edge') fail('edit.id', `port "${edit.id}" is an SMA on the board edge; change its x in the project instead`);
      undo = { op: 'move_port', id: port.id, x: port.x, y: port.y };
      port.x = edit.x;
      port.y = edit.y;
      break;
    }
  }
  const edited = parseProject(doc);
  assertLockedValuesUnchanged(project, edited);
  return { project: edited, undo };
}

const showQuantity = ({ value, dim }: Quantity) => (dim === 0 ? `${value}` : `${value} mm${dim === 1 ? '' : `^${dim}`}`);

/** A lock pins the value, not the text: editing a variable a locked one depends on is refused too. */
function assertLockedValuesUnchanged(before: Project, after: Project): void {
  const old = resolveProject(before).variables;
  const now = resolveProject(after).variables;
  for (const [name, def] of Object.entries(before.variables)) {
    if (!def.locked) continue;
    if (old[name].value !== now[name].value || old[name].dim !== now[name].dim) {
      fail('edit', `would change locked variable "${name}" from ${showQuantity(old[name])} to ${showQuantity(now[name])}`);
    }
  }
}
