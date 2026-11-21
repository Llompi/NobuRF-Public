import { failImport } from './geometry';

/**
 * Reader for the ISO 10303-21 ("Part 21") text that STEP files are written
 * in: a HEADER section and a DATA section of numbered entity instances,
 *
 *   #12 = CARTESIAN_POINT('',(0.,1.5,0.));
 *   #40 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
 *
 * The second form is a complex instance: one entity made of several
 * partial records. This file only turns text into records; step.ts gives
 * them meaning.
 */

/** A reference to another instance, `#12`. */
export class StepRef {
  constructor(readonly id: number) {}
}

/** An enumeration value, `.T.` or `.MILLI.`. */
export class StepEnum {
  constructor(readonly name: string) {}
}

/** A typed parameter, `LENGTH_MEASURE(25.4)`. */
export class StepTyped {
  constructor(readonly type: string, readonly args: StepValue[]) {}
}

/** `$` (no value) and `*` (derived value) are both read as null. */
export type StepValue = number | string | StepRef | StepEnum | StepTyped | null | StepValue[];

export interface StepRecord {
  type: string;
  args: StepValue[];
}

export interface StepInstance {
  id: number;
  /** 1-based line of the `#id =` in the file, for error messages. */
  line: number;
  /** One record for a simple instance, several for a complex one. */
  records: StepRecord[];
}

/**
 * Statements end at `;` outside strings and comments. Comments are left out
 * of the body; `line` is where the statement's first character is.
 */
function* statements(text: string, sourceName: string): Generator<{ body: string; line: number }> {
  let line = 1;
  let body = '';
  let start = 0;
  let startLine: number | undefined;
  for (let n = 0; n < text.length; n++) {
    const c = text[n];
    if (c === '\n') {
      line++;
      continue;
    }
    if (c === '/' && text[n + 1] === '*') {
      const end = text.indexOf('*/', n + 2);
      if (end < 0) failImport(sourceName, line, 'a comment is never closed');
      body += text.slice(start, n) + ' ';
      for (let k = n; k < end; k++) if (text[k] === '\n') line++;
      n = end + 1;
      start = n + 1;
      continue;
    }
    if (startLine === undefined && !/\s/.test(c)) startLine = line;
    if (c === "'") {
      // A quote inside a string is written twice: 'it''s'.
      const stringLine = line;
      for (n++; n < text.length && !(text[n] === "'" && text[n + 1] !== "'"); n++) {
        if (text[n] === "'") n++;
        else if (text[n] === '\n') line++;
      }
      if (n >= text.length) failImport(sourceName, stringLine, 'a string is never closed');
    } else if (c === ';') {
      yield { body: body + text.slice(start, n), line: startLine ?? line };
      body = '';
      start = n + 1;
      startLine = undefined;
    }
  }
  if ((body + text.slice(start)).trim() !== '') failImport(sourceName, startLine ?? line, 'the file ends in the middle of a statement (is it cut short?)');
}

const TOKEN = /\s*(?:(#\d+)|('(?:[^']|'')*')|(\.[A-Z_][A-Z0-9_]*\.)|([A-Z_][A-Z0-9_]*)|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([(),$*]))/gy;

/** Parse the parameter list or complex-instance body that starts at `text`. */
function parseBody(text: string, sourceName: string, line: number): StepRecord[] {
  TOKEN.lastIndex = 0;
  const tokens: string[] = [];
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) {
      if (/^\s*$/.test(text.slice(at))) break;
      failImport(sourceName, line, `cannot read "${text.slice(at, at + 20).trim()}"`);
    }
    tokens.push(m[0].trim());
  }
  let pos = 0;
  const fail = (what: string): never => failImport(sourceName, line, `${what} (near "${tokens.slice(pos, pos + 4).join(' ')}")`);
  const expect = (t: string) => {
    if (tokens[pos] !== t) fail(`expected "${t}"`);
    pos++;
  };
  const value = (): StepValue => {
    const t = tokens[pos++];
    if (t === undefined) return fail('the statement ends early');
    if (t === '$' || t === '*') return null;
    if (t === '(') {
      const list: StepValue[] = [];
      if (tokens[pos] === ')') {
        pos++;
        return list;
      }
      for (;;) {
        list.push(value());
        if (tokens[pos] === ',') pos++;
        else break;
      }
      expect(')');
      return list;
    }
    if (t[0] === '#') return new StepRef(Number(t.slice(1)));
    if (t[0] === "'") return t.slice(1, -1).replace(/''/g, "'");
    if (/^\.[A-Z_]/.test(t)) return new StepEnum(t.slice(1, -1));
    if (/^[A-Z_]/.test(t)) {
      expect('(');
      pos--;
      const args = value() as StepValue[];
      return new StepTyped(t, args);
    }
    const number = Number(t);
    if (!Number.isFinite(number)) return fail(`"${t}" is not a number`);
    return number;
  };
  const record = (): StepRecord => {
    const type = tokens[pos++];
    if (!type || !/^[A-Z_]/.test(type)) return fail('expected an entity name');
    if (tokens[pos] !== '(') return fail(`expected "(" after ${type}`);
    return { type, args: value() as StepValue[] };
  };
  const records: StepRecord[] = [];
  if (tokens[0] === '(') {
    pos++;
    while (tokens[pos] !== ')') {
      if (pos >= tokens.length) fail('a complex instance is never closed');
      records.push(record());
    }
    pos++;
  } else {
    records.push(record());
  }
  if (pos !== tokens.length) fail('unexpected text after the instance');
  return records;
}

/** All instances of the DATA section, by id. */
export function parseStepFile(text: string, sourceName: string): Map<number, StepInstance> {
  if (!/^\s*ISO-10303-21\s*;/.test(text)) {
    failImport(sourceName, 1, 'not a STEP file: it must start with "ISO-10303-21;" (binary and zipped STEP are not read)');
  }
  const instances = new Map<number, StepInstance>();
  let section: string | undefined;
  let dataClosed = false;
  for (const { body, line } of statements(text, sourceName)) {
    const trimmed = body.trim();
    // Edition 3 files may name their DATA sections: DATA('name', (...schemas)).
    if (trimmed === 'HEADER' || /^DATA\s*(\([\s\S]*\))?$/.test(trimmed)) section = trimmed === 'HEADER' ? 'HEADER' : 'DATA';
    else if (trimmed === 'ENDSEC') {
      if (section === 'DATA') dataClosed = true;
      section = undefined;
    } else if (section === 'DATA') {
      const m = /^#(\d+)\s*=\s*([\s\S]*)$/.exec(trimmed);
      if (!m) failImport(sourceName, line, `expected "#<id> = ..." in the DATA section, found "${trimmed.slice(0, 30)}"`);
      const id = Number(m[1]);
      if (instances.has(id)) failImport(sourceName, line, `#${id} is defined twice`);
      instances.set(id, { id, line, records: parseBody(m[2], sourceName, line) });
    }
  }
  if (section === 'DATA' || (instances.size > 0 && !dataClosed)) failImport(sourceName, undefined, 'the DATA section never ends (ENDSEC); is the file cut short?');
  if (instances.size === 0) failImport(sourceName, undefined, 'the file has no DATA section entities');
  return instances;
}
