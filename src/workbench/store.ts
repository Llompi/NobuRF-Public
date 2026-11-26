/**
 * The open project: one JSON document, its undo history, and what the schema
 * says about it. The document may be invalid while someone edits it; the
 * schema (parseProject) is the only validator, and its error names the JSON
 * path, which the editors use to put the message next to the field.
 */
import { resolveProject, type ResolvedProject } from '../project/resolve';
import { parseProject, ProjectError, type Project } from '../project/schema';
import { serialiseProject } from '../import/project';

export type JsonPath = Array<string | number>;
type Json = unknown;

export interface Validation {
  /** The parsed project, or null when the document is invalid. */
  project: Project | null;
  resolved: ResolvedProject | null;
  error: { path: string; message: string } | null;
}

/** "$.ports[0].x" for ['ports', 0, 'x'], the form parseProject uses in its errors. */
export function pathString(path: JsonPath): string {
  return '$' + path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('');
}

export function getAt(doc: Json, path: JsonPath): Json {
  let node = doc;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, Json>)[key];
  }
  return node;
}

/** A copy of `doc` with the value at `path` replaced; `undefined` deletes an object key. */
export function setAt(doc: Json, path: JsonPath, value: Json): Json {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  const node = (doc ?? (typeof key === 'number' ? [] : {})) as Record<string | number, Json>;
  const copy = (Array.isArray(node) ? [...node] : { ...node }) as Record<string | number, Json>;
  const next = setAt(node[key], rest, value);
  if (next === undefined && !Array.isArray(copy)) delete copy[key];
  else copy[key] = next;
  return copy;
}

/** Outputs that only post-process a solve, so changing them never makes its results stale: the differential pairing and the far-field array drives. */
const POST_PROCESSING_OUTPUTS = ['differential_pairs', 'array_excitation'];

/** The document without its post-processing outputs, which a solve does not depend on: what staleness compares. */
export function solveRelevantText(doc: Json): string {
  const outputs = (doc as { outputs?: Json } | null)?.outputs;
  if (!outputs || typeof outputs !== 'object') return JSON.stringify(doc);
  const solveOutputs = Object.fromEntries(Object.entries(outputs).filter(([key]) => !POST_PROCESSING_OUTPUTS.includes(key)));
  return JSON.stringify({ ...(doc as Record<string, Json>), outputs: solveOutputs });
}

/** Splits a schema error "$.a.b[0]: message" into its path and message. */
export function splitProjectError(error: unknown): { path: string; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  const match = error instanceof ProjectError ? /^(\$[^:]*): (.*)$/s.exec(text) : null;
  return match ? { path: match[1], message: match[2] } : { path: '$', message: text };
}

export function validate(doc: Json): Validation {
  try {
    // parseProject reads, never writes; the clone keeps the editable document out of the parsed one.
    const project = parseProject(structuredClone(doc));
    return { project, resolved: resolveProject(project), error: null };
  } catch (error) {
    return { project: null, resolved: null, error: splitProjectError(error) };
  }
}

const HISTORY_LIMIT = 200;

export class ProjectStore {
  private doc: Json;
  private undoStack: Json[] = [];
  private redoStack: Json[] = [];
  private listeners = new Set<() => void>();
  validation: Validation;
  /** Name of the file the project came from, for Save. */
  fileName: string;
  /** The document as last opened or saved; `dirty` compares against it. */
  private savedJson: string;

  constructor(doc: Json, fileName: string) {
    this.doc = doc;
    this.fileName = fileName;
    this.savedJson = JSON.stringify(doc);
    this.validation = validate(doc);
    this.lastValid = this.validation.project ? this.validation : null;
  }

  /** True when the document differs from what was last opened or saved. Undoing back to it clears it. */
  get dirty(): boolean {
    return JSON.stringify(this.doc) !== this.savedJson;
  }

  /** The document as last opened or saved, for the autosave to carry across a reload. */
  get savedDocument(): Json {
    return JSON.parse(this.savedJson);
  }

  /** Call after the document was written to a file. */
  markSaved(): void {
    this.savedJson = JSON.stringify(this.doc);
    for (const listener of this.listeners) listener();
  }

  get document(): Json {
    return this.doc;
  }

  /** The last valid project, so views keep showing something while an edit is invalid. */
  lastValid: Validation | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: Json): void {
    this.validation = validate(next);
    if (this.validation.project) this.lastValid = this.validation;
    this.doc = next;
    for (const listener of this.listeners) listener();
  }

  /**
   * Replace the whole document (open a file); clears the history. `saved` is
   * the version on disk when it differs from `doc`, as after restoring an
   * autosave that held unsaved edits.
   */
  load(doc: Json, fileName: string, saved: Json = doc): void {
    this.undoStack = [];
    this.redoStack = [];
    this.fileName = fileName;
    this.savedJson = JSON.stringify(saved);
    this.lastValid = null;
    this.commit(doc);
  }

  /** Apply an edit; it can be undone. */
  update(change: (doc: Json) => Json): void {
    const next = change(this.doc);
    if (JSON.stringify(next) === JSON.stringify(this.doc)) return;
    this.undoStack.push(this.doc);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.commit(next);
  }

  set(path: JsonPath, value: Json): void {
    this.update((doc) => setAt(doc, path, value));
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (previous === undefined) return;
    this.redoStack.push(this.doc);
    this.commit(previous);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.doc);
    this.commit(next);
  }

  /** The document as the CLI writes projects: two-space JSON, points on one line. */
  text(): string {
    return serialiseProject(this.doc as Project);
  }
}
