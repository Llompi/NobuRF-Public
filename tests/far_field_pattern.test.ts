import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Mesh } from 'three';
import {
  boresightPolarisation, halfPowerBeamwidthDeg, patternFigures, planeCut, polarisedDirectivity, toDb, type FarFieldPattern,
} from '../src/engine/far_field_pattern';
import { encodeGlb } from '../src/viewer/glb';
import { lobeMesh } from '../src/viewer/lobe_mesh';
import { patternCutsSvg } from '../src/viewer/pattern_plot';

const deg = (x: number) => (x * Math.PI) / 180;

/**
 * A synthetic far field on the 5 degree grid: a beam cos(theta)^n toward +z
 * (zero below the horizon), Ludwig-3 co-polar for y, plus `crossShare` of
 * cross-polar power. Directivity follows from the fields by a sphere integral.
 */
function syntheticPattern(n: number, crossShare = 0): FarFieldPattern {
  const thetaDeg = Float64Array.from({ length: 37 }, (_, t) => 5 * t);
  const phiDeg = Float64Array.from({ length: 72 }, (_, p) => 5 * p);
  const size = thetaDeg.length * phiDeg.length;
  const f = { rEThetaRe: new Float64Array(size), rEThetaIm: new Float64Array(size), rEPhiRe: new Float64Array(size), rEPhiIm: new Float64Array(size) };
  const u = new Float64Array(size);
  let power = 0;
  for (let t = 0; t < thetaDeg.length; t++) {
    const theta = deg(thetaDeg[t]);
    const amplitude = theta < Math.PI / 2 ? Math.cos(theta) ** n : 0;
    for (let p = 0; p < phiDeg.length; p++) {
      const phi = deg(phiDeg[p]);
      const s = t * phiDeg.length + p;
      // Ludwig-3 unit vectors for y: co = sin(phi) theta_hat + cos(phi) phi_hat, cross = cos(phi) theta_hat - sin(phi) phi_hat.
      const [co, cross] = [amplitude, amplitude * Math.sqrt(crossShare)];
      f.rEThetaRe[s] = co * Math.sin(phi) + cross * Math.cos(phi);
      f.rEPhiRe[s] = co * Math.cos(phi) - cross * Math.sin(phi);
      u[s] = f.rEThetaRe[s] ** 2 + f.rEPhiRe[s] ** 2;
      power += u[s] * Math.sin(theta) * deg(5) * deg(5) * (t === 0 || t === 36 ? 0.5 : 1);
    }
  }
  return { thetaDeg, phiDeg, ...f, directivityDbi: u.map((x) => toDb((4 * Math.PI * x) / power)) };
}

describe('pattern figures', () => {
  it('splits co- and cross-polar by Ludwig 3 and they add up to the total', () => {
    const r = syntheticPattern(2, 0.01);
    const { co, cross } = polarisedDirectivity(r, 'y');
    for (const n of [0, 100, 500, 1000]) {
      expect(co[n] + cross[n]).toBeCloseTo(10 ** (r.directivityDbi[n] / 10), 9);
      if (co[n] > 0) expect(cross[n] / co[n]).toBeCloseTo(0.01, 6);
    }
    expect(boresightPolarisation(r)).toBe('y');
    expect(patternFigures(r, 'y').boresightCrossPolarDb).toBeCloseTo(-20, 6);
  });

  it('reduces to E_theta and E_phi in the principal planes, as range practice states', () => {
    // Independent of the general formula: for a y reference the co-polar field is
    // E_theta in the yz plane (phi = 90, 270) and E_phi in the xz plane (phi = 0, 180),
    // and the cross-polar field is the other component. Random fields everywhere.
    const r = syntheticPattern(1);
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    for (const f of [r.rEThetaRe, r.rEThetaIm, r.rEPhiRe, r.rEPhiIm]) for (let n = 0; n < f.length; n++) f[n] = random();
    const { co, cross } = polarisedDirectivity(r, 'y');
    const other = polarisedDirectivity(r, 'x');
    const np = r.phiDeg.length;
    for (let t = 1; t < r.thetaDeg.length - 1; t++) {
      for (const [phi, coIsTheta] of [[0, false], [90, true], [180, false], [270, true]] as const) {
        const n = t * np + r.phiDeg.indexOf(phi);
        const theta2 = r.rEThetaRe[n] ** 2 + r.rEThetaIm[n] ** 2;
        const phi2 = r.rEPhiRe[n] ** 2 + r.rEPhiIm[n] ** 2;
        const total = 10 ** (r.directivityDbi[n] / 10) / (theta2 + phi2);
        expect(co[n]).toBeCloseTo((coIsTheta ? theta2 : phi2) * total, 9);
        expect(cross[n]).toBeCloseTo((coIsTheta ? phi2 : theta2) * total, 9);
      }
    }
    // Swapping the reference axis swaps co and cross everywhere.
    for (let n = 0; n < co.length; n += 97) {
      expect(other.co[n]).toBeCloseTo(cross[n], 9);
      expect(other.cross[n]).toBeCloseTo(co[n], 9);
    }
  });

  it('cuts a plane from -180 to 180 with the negative half at phi + 180', () => {
    const r = syntheticPattern(2);
    const index = Float64Array.from({ length: r.directivityDbi.length }, (_, n) => n);
    const cut = planeCut(r, index, 90);
    expect(cut.angleDeg[0]).toBe(-180);
    expect(cut.angleDeg[36]).toBe(0);
    expect(cut.angleDeg[72]).toBe(180);
    // theta = 30 toward phi = 90 is sample 6 * 72 + 18; toward phi = 270, 6 * 72 + 54.
    expect(cut.value[36 + 6]).toBe(6 * 72 + 18);
    expect(cut.value[36 - 6]).toBe(6 * 72 + 54);
    expect(() => planeCut(r, index, 92)).toThrow(/not both on the far-field grid/);
  });

  it('measures the half-power beamwidth of cos^n beams', () => {
    for (const n of [1, 2, 4]) {
      const r = syntheticPattern(n);
      const exact = 2 * (180 / Math.PI) * Math.acos(0.5 ** (1 / (2 * n)));
      const figures = patternFigures(r, 'y');
      // Linear interpolation over 5 degree samples: within a degree.
      expect(Math.abs(figures.beamwidthEPlaneDeg! - exact)).toBeLessThan(1);
      expect(Math.abs(figures.beamwidthHPlaneDeg! - exact)).toBeLessThan(1);
      expect(figures.frontToBackDb).toBeGreaterThan(100); // nothing below the horizon
    }
  });

  it('reports no beamwidth when the cut never falls 3 dB', () => {
    const flat = { angleDeg: Float64Array.of(-10, 0, 10), value: Float64Array.of(1, 1, 1) };
    expect(halfPowerBeamwidthDeg(flat)).toBeNull();
  });
});

describe('pattern outputs', () => {
  const r = syntheticPattern(2, 0.001);

  it('draws both cuts with both polarisations', () => {
    const svg = patternCutsSvg({ pattern: r, frequencyGHz: 5.8, polarisation: 'y', caption: 'test <&>' });
    expect(svg).toContain('E-plane (φ = 90°)');
    expect(svg).toContain('H-plane (φ = 0°)');
    expect(svg.match(/class="trace co"/g)).toHaveLength(3); // two panels and the legend
    expect(svg.match(/class="trace cross"/g)).toHaveLength(3);
    expect(svg).toContain('test &lt;&amp;&gt;');
    expect(svg).not.toMatch(/NaN|Infinity/);
  });

  it('builds an outward-facing lobe with the peak at radius 1', () => {
    const mesh = lobeMesh(r.thetaDeg, r.phiDeg, r.directivityDbi, 30);
    let maxRadius = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) maxRadius = Math.max(maxRadius, Math.hypot(...mesh.positions.subarray(3 * v, 3 * v + 3)));
    expect(maxRadius).toBeCloseTo(1, 6);
    // A triangle near the beam: its normal points away from the origin.
    const t = 2 * 72 * 6 + 10 * 6; // theta row 2, phi column 10
    const [a, b, c] = [0, 1, 2].map((k) => mesh.positions.subarray(3 * mesh.indices[t + k], 3 * mesh.indices[t + k] + 3));
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    expect(normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2]).toBeGreaterThan(0);
  });

  it('writes a glTF file that three.js loads back', async () => {
    const mesh = lobeMesh(r.thetaDeg, r.phiDeg, r.directivityDbi, 30);
    const glb = encodeGlb(mesh, 'lobe', 0.1);
    const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '');
    let loaded: Mesh | undefined;
    gltf.scene.traverse((o) => { if ((o as Mesh).isMesh) loaded = o as Mesh; });
    expect(loaded).toBeDefined();
    const geometry = loaded!.geometry;
    expect(geometry.getAttribute('position').count).toBe(mesh.positions.length / 3);
    expect(geometry.getAttribute('color').count).toBe(mesh.positions.length / 3);
    expect(geometry.index!.count).toBe(mesh.indices.length);
    geometry.computeBoundingSphere();
    expect(geometry.boundingSphere!.radius).toBeGreaterThan(0.05);
  });
});
