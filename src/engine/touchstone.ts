import type { ScatteringResult } from './port_dft';

/**
 * Touchstone v1 data lines of an N-port S-matrix, real/imaginary pairs. Two
 * ports: one line per frequency in the order S11 S21 S12 S22. Three or more:
 * one matrix row per line (S_i1 ... S_iN), at most four pairs per line, the
 * frequency only on the first.
 */
export function touchstoneLines(s: ScatteringResult): string[] {
  const n = s.re.length;
  const pair = (i: number, j: number, m: number) => `${s.re[i][j]![m].toExponential(9)} ${s.im[i][j]![m].toExponential(9)}`;
  return Array.from(s.fGHz, (f, m) => {
    const freq = f.toFixed(6);
    if (n === 2) return `${freq} ${pair(0, 0, m)} ${pair(1, 0, m)} ${pair(0, 1, m)} ${pair(1, 1, m)}`;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      for (let j0 = 0; j0 < n; j0 += 4) {
        const pairs = Array.from({ length: Math.min(4, n - j0) }, (_, k) => pair(i, j0 + k, m)).join(' ');
        lines.push(i === 0 && j0 === 0 ? `${freq} ${pairs}` : pairs);
      }
    }
    return lines.join('\n');
  });
}

const FREQUENCY_UNITS: Record<string, number> = { HZ: 1e-9, KHZ: 1e-6, MHZ: 1e-3, GHZ: 1 };

/**
 * An N-port Touchstone v1 file (S-parameters in RI, MA or DB, any frequency
 * unit, one real reference impedance), the inverse of touchstoneLines. N comes
 * from the file name's .sNp extension.
 */
export function parseTouchstone(text: string, portCount: number): { s: ScatteringResult; z0: number } {
  if (!(Number.isInteger(portCount) && portCount >= 1)) throw new Error(`port count must be a whole number of 1 or more, got ${portCount}`);
  let unit = 1; // GHz, the Touchstone default
  let format = 'MA';
  let z0 = 50;
  let sawOptions = false;
  const numbers: number[] = [];
  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/!.*/, '').trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (sawOptions) continue; // Touchstone: only the first option line counts
      sawOptions = true;
      const words = line.slice(1).trim().toUpperCase().split(/\s+/);
      for (let w = 0; w < words.length; w++) {
        const word = words[w];
        if (word in FREQUENCY_UNITS) unit = FREQUENCY_UNITS[word];
        else if (word === 'RI' || word === 'MA' || word === 'DB') format = word;
        else if (word === 'R') z0 = Number(words[++w]);
        else if (word !== 'S') throw new Error(`line ${n + 1}: only S-parameter files are read, not "${word}"`);
      }
      if (!(z0 > 0)) throw new Error(`line ${n + 1}: the reference impedance must be above 0 Ω`);
      continue;
    }
    if (line.startsWith('[')) throw new Error(`line ${n + 1}: Touchstone v2 keywords are not read yet; export as v1`);
    for (const token of line.split(/\s+/)) {
      const x = Number(token);
      if (!Number.isFinite(x)) throw new Error(`line ${n + 1}: "${token}" is not a number`);
      numbers.push(x);
    }
  }
  const perFrequency = 1 + 2 * portCount * portCount;
  // Frequency blocks until the numbers run out or, in a two-port file, the frequency stops rising: noise parameters follow there.
  let nf = 0;
  while (nf * perFrequency < numbers.length) {
    const base = nf * perFrequency;
    if (nf > 0 && numbers[base] <= numbers[base - perFrequency]) {
      if (portCount === 2) break;
      throw new Error(`frequency ${numbers[base]} does not rise after ${numbers[base - perFrequency]}: is the port count right?`);
    }
    if (base + perFrequency > numbers.length) {
      throw new Error(`${numbers.length} numbers do not divide into frequencies of ${perFrequency} (a ${portCount}-port file): is the port count right?`);
    }
    nf++;
  }
  if (nf === 0) throw new Error('no S-parameter data in the file');
  const fGHz = new Float64Array(nf);
  const re = Array.from({ length: portCount }, () => Array.from({ length: portCount }, () => new Float64Array(nf)));
  const im = Array.from({ length: portCount }, () => Array.from({ length: portCount }, () => new Float64Array(nf)));
  for (let m = 0; m < nf; m++) {
    const base = m * perFrequency;
    fGHz[m] = numbers[base] * unit;
    for (let q = 0; q < portCount * portCount; q++) {
      // Row-major, except a two-port file, which lists S11 S21 S12 S22.
      const [i, j] = portCount === 2 ? [q % 2, Math.floor(q / 2)] : [Math.floor(q / portCount), q % portCount];
      const [a, b] = [numbers[base + 1 + 2 * q], numbers[base + 2 + 2 * q]];
      const magnitude = format === 'DB' ? 10 ** (a / 20) : a;
      const angle = (b * Math.PI) / 180;
      [re[i][j][m], im[i][j][m]] = format === 'RI' ? [a, b] : [magnitude * Math.cos(angle), magnitude * Math.sin(angle)];
    }
  }
  return { s: { fGHz, re, im, method: 'full', maxPassiveIncidentRatio: 0 }, z0 };
}
