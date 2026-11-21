/**
 * Colour scales for field plots, defined in sRGB (what the legend shows) and
 * converted to linear RGB for Three.js vertex colours, so plot and legend match.
 */
type Stops = Array<[position: number, srgb: [number, number, number]]>;

/** |E| and directivity: blue to red through cyan, green and yellow, the commercial-solver default an RF engineer reads without a key. */
export const MAGNITUDE_SCALE: Stops = [
  [0.0, [0.16, 0.25, 0.78]],
  [0.25, [0.13, 0.62, 0.87]],
  [0.5, [0.27, 0.76, 0.4]],
  [0.75, [0.96, 0.83, 0.26]],
  [1.0, [0.9, 0.24, 0.18]],
];

/** Signed fields (Ez at an instant): blue negative, dark at zero, red positive, so the two radiating edges read as opposite signs. */
export const SIGNED_SCALE: Stops = [
  [0.0, [0.3, 0.55, 1.0]],
  [0.5, [0.1, 0.11, 0.13]],
  [1.0, [1.0, 0.36, 0.25]],
];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The sRGB colour at x in [0, 1]. */
function sampleScale(stops: Stops, x: number): [number, number, number] {
  let s = 1;
  while (s < stops.length - 1 && x > stops[s][0]) s++;
  const [p0, c0] = stops[s - 1];
  const [p1, c1] = stops[s];
  const w = (x - p0) / (p1 - p0);
  return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * w) as [number, number, number];
}

/** 256-entry lookup table of linear RGB triples. */
export function linearLut(stops: Stops): Float32Array {
  const lut = new Float32Array(256 * 3);
  for (let n = 0; n < 256; n++) {
    const rgb = sampleScale(stops, n / 255);
    for (let k = 0; k < 3; k++) lut[n * 3 + k] = srgbToLinear(rgb[k]);
  }
  return lut;
}

/** 256-entry lookup table of 8-bit sRGB triples, for 2D canvas images. */
export function srgbLut(stops: Stops): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let n = 0; n < 256; n++) {
    const rgb = sampleScale(stops, n / 255);
    for (let k = 0; k < 3; k++) lut[n * 3 + k] = Math.round(rgb[k] * 255);
  }
  return lut;
}

/** CSS gradient of a scale, bottom (0) to top (1). */
export function scaleCss(stops: Stops): string {
  const parts = stops.map(([p, [r, g, b]]) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}) ${p * 100}%`);
  return `linear-gradient(to top, ${parts.join(', ')})`;
}
