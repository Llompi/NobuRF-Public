import { describe, expect, it } from 'vitest';
import { muxWebm, sizeVint } from '../src/workbench/webm';

/** Reads one EBML element at `at`: its id, the body's start and its size. */
function readElement(bytes: Uint8Array, at: number): { id: number; body: number; size: number } {
  const vintLength = (b: number) => Math.clz32(b) - 23;
  const idLength = vintLength(bytes[at]);
  let id = 0;
  for (let n = 0; n < idLength; n++) id = id * 256 + bytes[at + n];
  const sizeAt = at + idLength;
  const sizeLength = vintLength(bytes[sizeAt]);
  let size = bytes[sizeAt] & (0xff >> sizeLength);
  for (let n = 1; n < sizeLength; n++) size = size * 256 + bytes[sizeAt + n];
  return { id, body: sizeAt + sizeLength, size };
}

function children(bytes: Uint8Array, start: number, end: number): Array<{ id: number; body: number; size: number }> {
  const out = [];
  for (let at = start; at < end; ) {
    const e = readElement(bytes, at);
    out.push(e);
    at = e.body + e.size;
  }
  expect(out.length > 0 && out.at(-1)!.body + out.at(-1)!.size).toBe(end);
  return out;
}

describe('sizeVint', () => {
  it('uses the shortest length and never the reserved all-ones value', () => {
    expect([...sizeVint(0)]).toEqual([0x80]);
    expect([...sizeVint(126)]).toEqual([0xfe]);
    expect([...sizeVint(127)]).toEqual([0x40, 0x7f]);
    expect([...sizeVint(300)]).toEqual([0x41, 0x2c]);
  });
});

describe('muxWebm', () => {
  const frames = [0, 33.333, 66.667].map((timeMs, k) => ({ timeMs, key: k === 0, data: Uint8Array.from([k, k, k]) }));
  const file = muxWebm({ codecId: 'V_VP9', width: 640, height: 480 }, frames, 100);

  it('nests header, info, tracks and one cluster with every frame in order', () => {
    const [header, segment] = children(file, 0, file.length);
    expect(header.id).toBe(0x1a45dfa3);
    expect(segment.id).toBe(0x18538067);
    const parts = children(file, segment.body, segment.body + segment.size);
    expect(parts.map((p) => p.id)).toEqual([0x1549a966, 0x1654ae6b, 0x1f43b675]);
    const cluster = parts[2];
    const blocks = children(file, cluster.body, cluster.body + cluster.size).filter((e) => e.id === 0xa3);
    expect(blocks.map((b) => new DataView(file.buffer, b.body + 1, 2).getInt16(0))).toEqual([0, 33, 67]);
    expect(blocks.map((b) => file[b.body + 3])).toEqual([0x80, 0, 0]);
    expect(blocks.map((b) => file[b.body + 4])).toEqual([0, 1, 2]);
  });

  it('refuses an empty clip and one too long for a single cluster', () => {
    expect(() => muxWebm({ codecId: 'V_VP9', width: 2, height: 2 }, [], 0)).toThrow();
    expect(() => muxWebm({ codecId: 'V_VP9', width: 2, height: 2 }, [{ timeMs: 40_000, key: true, data: new Uint8Array(1) }], 40_000)).toThrow();
  });
});
