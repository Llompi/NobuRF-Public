/**
 * Result files to take elsewhere: Touchstone for a circuit simulator, CSV for
 * a spreadsheet, and the charts as PNG images.
 */
import { touchstoneLines } from '../engine/touchstone';
import type { WorkbenchResult } from './solve';

export const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_');

/** Touchstone v1 of the S-matrix, or null when some port was not excited (a column is missing). */
export function touchstoneFile(r: WorkbenchResult): { fileName: string; text: string } | null {
  const n = r.portIds.length;
  if (r.s.re.some((row) => row.some((column) => !column))) return null;
  const header = [
    `! NobuRF ${r.projectName}: ${n === 1 ? `port "${r.portIds[0]}"` : `ports ${r.portIds.map((id, k) => `${k + 1} "${id}"`).join(', ')}`}; ${r.solver}`,
    `# GHz S RI R ${r.z0[0]}`,
  ];
  // Touchstone v1 is ASCII; some strict readers reject anything else in a comment.
  const ascii = (line: string) => line.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
  return { fileName: `${safeName(r.projectName)}.s${n}p`, text: [...header.map(ascii), ...touchstoneLines(r.s)].join('\n') + '\n' };
}

/** One row per frequency: every measured S in dB and degrees, named with its reference impedance, and Z of each excited port. */
export function csvFile(r: WorkbenchResult): { fileName: string; text: string } {
  const columns: Array<{ name: string; values: ArrayLike<number> }> = [];
  const n = r.portIds.length;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [re, im] = [r.s.re[i][j], r.s.im[i][j]];
      if (!re || !im) continue;
      const reference = r.z0[i] === r.z0[j] ? `${r.z0[i]} ohm` : `${r.z0[i]}/${r.z0[j]} ohm`;
      const s = `S${i + 1}${j + 1}`;
      columns.push({ name: `${s} dB (${reference})`, values: Array.from(re, (x, m) => 20 * Math.log10(Math.hypot(x, im[m]))) });
      columns.push({ name: `${s} deg (${reference})`, values: Array.from(re, (x, m) => (Math.atan2(im[m], x) * 180) / Math.PI) });
    }
  }
  // Z shares the S frequencies: both come from the same port spectrum.
  for (const run of r.runs) {
    const suffix = r.runs.length > 1 ? ` ${run.portId}` : '';
    columns.push({ name: `Re Z${suffix} ohm`, values: run.spectrum.zRe }, { name: `Im Z${suffix} ohm`, values: run.spectrum.zIm });
  }
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [['f GHz', ...columns.map((c) => c.name)].map(quote).join(',')];
  for (let m = 0; m < r.s.fGHz.length; m++) {
    lines.push([r.s.fGHz[m].toFixed(6), ...columns.map((c) => Number(c.values[m]).toPrecision(8))].join(','));
  }
  return { fileName: `${safeName(r.projectName)}.csv`, text: lines.join('\n') + '\n' };
}

/** A chart canvas as PNG, on the page background so it reads outside the app. */
export function chartPng(canvas: HTMLCanvasElement, background: string): Promise<Blob> {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return new Promise((resolve, reject) => out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the browser could not encode the image'))), 'image/png'));
}

export function download(fileName: string, data: Blob | string, type = 'text/plain'): void {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
