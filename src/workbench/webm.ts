/**
 * The smallest WebM a player needs for one short video track: EBML header,
 * segment info with the duration, one track, and one cluster of SimpleBlocks.
 * Enough for clips of a few seconds (block times are 16-bit milliseconds from
 * the cluster start, so up to about 32 s); there are no cues, which a clip
 * this short does not need for seeking.
 *
 * Spec: https://www.matroska.org/technical/elements.html (WebM is its subset).
 */

export interface EncodedFrame {
  /** Presentation time in milliseconds from the start of the clip. */
  timeMs: number;
  key: boolean;
  data: Uint8Array;
}

export interface WebmTrack {
  /** Matroska codec id, e.g. V_VP9 or V_VP8. */
  codecId: string;
  width: number;
  height: number;
}

const MAX_BLOCK_OFFSET_MS = 0x7fff;

export function muxWebm(track: WebmTrack, frames: EncodedFrame[], durationMs: number): Uint8Array {
  if (frames.length === 0) throw new Error('no frames to write');
  const last = frames[frames.length - 1].timeMs;
  if (last > MAX_BLOCK_OFFSET_MS) throw new Error(`clip too long for one cluster: ${last} ms`);
  const header = element(0x1a45dfa3, [
    uintElement(0x4286, 1), // EBMLVersion
    uintElement(0x42f7, 1), // EBMLReadVersion
    uintElement(0x42f2, 4), // EBMLMaxIDLength
    uintElement(0x42f3, 8), // EBMLMaxSizeLength
    stringElement(0x4282, 'webm'), // DocType
    uintElement(0x4287, 2), // DocTypeVersion
    uintElement(0x4285, 2), // DocTypeReadVersion
  ]);
  const info = element(0x1549a966, [
    uintElement(0x2ad7b1, 1_000_000), // TimecodeScale: 1 ms
    stringElement(0x4d80, 'NobuRF'), // MuxingApp
    stringElement(0x5741, 'NobuRF'), // WritingApp
    floatElement(0x4489, durationMs), // Duration, in TimecodeScale units
  ]);
  const tracks = element(0x1654ae6b, [
    element(0xae, [
      uintElement(0xd7, 1), // TrackNumber
      uintElement(0x73c5, 1), // TrackUID
      uintElement(0x9c, 0), // FlagLacing
      stringElement(0x86, track.codecId), // CodecID
      uintElement(0x83, 1), // TrackType: video
      element(0xe0, [uintElement(0xb0, track.width), uintElement(0xba, track.height)]), // Video: PixelWidth, PixelHeight
    ]),
  ]);
  const cluster = element(0x1f43b675, [
    uintElement(0xe7, 0), // Cluster Timecode
    ...frames.map((f) => element(0xa3, [simpleBlock(f)])),
  ]);
  return concat([header, element(0x18538067, [info, tracks, cluster])]);
}

/** Track 1, a signed 16-bit time from the cluster start, and the keyframe flag, then the frame. */
function simpleBlock(frame: EncodedFrame): Uint8Array {
  const head = new Uint8Array(4);
  head[0] = 0x81; // track number 1 as a one-byte vint
  new DataView(head.buffer).setInt16(1, Math.round(frame.timeMs));
  head[3] = frame.key ? 0x80 : 0;
  return concat([head, frame.data]);
}

function element(id: number, children: Uint8Array[]): Uint8Array {
  const body = concat(children);
  return concat([idBytes(id), sizeVint(body.length), body]);
}

function uintElement(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  for (let v = value; bytes.length === 0 || v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return element(id, [Uint8Array.from(bytes)]);
}

function floatElement(id: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  return element(id, [bytes]);
}

function stringElement(id: number, value: string): Uint8Array {
  return element(id, [new TextEncoder().encode(value)]);
}

/** Element ids carry their own length marker, so they are written as their plain big-endian bytes. */
function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.from(bytes);
}

/** EBML data size: the shortest vint that holds it (an all-ones value is reserved for "unknown"). */
export function sizeVint(size: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    if (size < 2 ** (7 * length) - 1) {
      const bytes = new Uint8Array(length);
      let v = size;
      for (let n = length - 1; n >= 0; n--) {
        bytes[n] = v % 256;
        v = Math.floor(v / 256);
      }
      bytes[0] |= 1 << (8 - length);
      return bytes;
    }
  }
  throw new Error(`element too large: ${size} bytes`);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
