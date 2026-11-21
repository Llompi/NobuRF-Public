import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { FieldSolution } from '../engine/field_solution';
import { instantaneousField, phasorMagnitude } from '../engine/field_phasor';
import type { GridConfig, MicroGeometryDSL } from '../engine/types';
import type { VoxelModel } from '../engine/voxelize';
import { linearLut, MAGNITUDE_SCALE, scaleCss, SIGNED_SCALE } from './colormap';

/** What the field plot shows. */
export type FieldPlotMode =
  /** Re{Ez e^{j phase}} with the phase advancing (an "animate phase" view). Signed, normalised to ±1. */
  | 'instantaneous'
  /** |Ez| in dB below the plot's reference. Static. */
  | 'magnitude';

export interface FieldLegend {
  title: string;
  /** CSS gradient of the colour scale, bottom to top. */
  scaleCss: string;
  /** Labels for the bottom, middle and top of the colour bar. */
  ticks: [string, string, string];
}

const MAGNITUDE_RANGE_DB = 30;
/** Relief height (mm) at full scale when relief is on. */
const RELIEF_MM = 3;
/** Far-field balloon radius (mm) at peak directivity, and the dB range it shows. */
const BALLOON_MM = 8;
/** Gap between the board top and the field plot when relief is on, so the copper stays visible under it. */
const RELIEF_LIFT_MM = 4;
const MAGNITUDE_LUT = linearLut(MAGNITUDE_SCALE);
const SIGNED_LUT = linearLut(SIGNED_SCALE);
const lutIndex = (level: number) => Math.round(Math.min(1, Math.max(0, level)) * 255) * 3;
const BALLOON_RANGE_DB = 30;

/**
 * Antenna viewport. Units: 1 scene unit = 1 mm, z up.
 *
 * - Copper comes from the voxel mask, so what you see is exactly what the
 *   solver simulated, grid snapping included. The patch outline is drawn over
 *   the field plot so the geometry stays readable.
 * - The field plot is Ez in the middle of the substrate at one frequency,
 *   colored with the commercial-solver scale, over the board's footprint.
 * - The far field is drawn as a directivity balloon above the board.
 */
export class Scene3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly board = new THREE.Group();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private fieldPlot: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  /** Grid node index for each field-plot vertex. */
  private fieldNodes: Int32Array = new Int32Array(0);
  private balloon: THREE.Group | null = null;
  private fields: FieldSolution | null = null;
  private magnitude: Float32Array | null = null;
  private reference = 1;
  private scratch = new Float32Array(0);
  private boardTopMm = 1.5;
  private lastFrameMs = 0;
  /** Set when the field plot needs recolouring; avoids re-uploading unchanged vertex data every frame. */
  private fieldDirty = false;

  mode: FieldPlotMode = 'instantaneous';
  relief = false;
  /** Field phase in radians; advances while `animatePhase` is on. */
  phaseRad = 0;
  animatePhase = !this.reducedMotion;
  /** Field cycles per second of wall time when animating. */
  phaseCyclesPerSecond = 0.5;

  constructor(private readonly host: HTMLElement, private readonly grid: GridConfig) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(34, -54, 40);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 2);
    this.controls.enableDamping = true;
    this.controls.autoRotate = !this.reducedMotion;
    this.controls.autoRotateSpeed = 0.4;
    this.controls.addEventListener('start', () => (this.controls.autoRotate = false));

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(30, -20, 60);
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.35), this.board);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = (nowMs: number) => {
      this.advance(nowMs);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // Narrow views (phones) widen the field of view so the whole board stays in frame; wide views (race lanes) zoom in.
    this.camera.fov = Math.min(60, Math.max(27, 32 * (1.3 / this.camera.aspect) ** 0.8));
    this.camera.updateProjectionMatrix();
  }

  /** Rebuild the board from a voxel model. Keeps the current fields until new ones arrive. */
  setGeometry(dsl: MicroGeometryDSL, model: VoxelModel): void {
    const { nx, ny, dxMm: dx } = this.grid;
    for (const child of this.board.children) disposeDeep(child);
    this.board.clear();
    this.fieldPlot = null;
    this.balloon = null;
    const h = (model.patchK - model.ports[0].k0) * dx;
    this.boardTopMm = h;

    const copper = new THREE.MeshPhysicalMaterial({ color: 0xc8793f, metalness: 1, roughness: 0.32 });
    const ground = new THREE.Mesh(new THREE.BoxGeometry(dsl.ground.w_mm, dsl.ground.l_mm, 0.1), copper);
    ground.position.z = -0.05;

    const substrateShape = new THREE.BoxGeometry(dsl.ground.w_mm, dsl.ground.l_mm, h);
    const substrate = new THREE.Mesh(
      substrateShape,
      new THREE.MeshStandardMaterial({ color: 0x3d5a3a, roughness: 0.8, transparent: true, opacity: 0.9 }),
    );
    substrate.position.z = h / 2;
    this.board.add(ground, substrate);

    // Top copper, one tile per voxel-mask cell.
    let tileCount = 0;
    for (const v of model.topCopper) tileCount += v;
    const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(dx, dx, 0.1), copper, Math.max(1, tileCount));
    const placement = new THREE.Matrix4();
    let placed = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!model.topCopper[i + nx * j]) continue;
        placement.makeTranslation((i + 0.5 - nx / 2) * dx, (j + 0.5 - ny / 2) * dx, h + 0.05);
        tiles.setMatrixAt(placed++, placement);
      }
    }
    tiles.count = placed;
    this.board.add(tiles);
    this.board.add(copperOutline(model.topCopper, nx, ny, dx, h + 0.3));

    // Port: the feed probe through the substrate.
    const probe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, h, 12),
      new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 1, roughness: 0.3 }),
    );
    probe.rotation.x = Math.PI / 2;
    probe.position.set((model.ports[0].i - nx / 2) * dx, (model.ports[0].j - ny / 2) * dx, h / 2);
    this.board.add(probe);

    this.buildFieldPlot(dsl, h);
    if (this.fields) this.buildBalloon();
  }

  private buildFieldPlot(dsl: MicroGeometryDSL, h: number): void {
    const { nx, ny, dxMm: dx } = this.grid;
    const half = (n: number) => Math.floor(n / 2);
    const iSpan = Math.floor(dsl.ground.w_mm / 2 / dx);
    const jSpan = Math.floor(dsl.ground.l_mm / 2 / dx);
    const i0 = half(nx) - iSpan, i1 = half(nx) + iSpan;
    const j0 = half(ny) - jSpan, j1 = half(ny) + jSpan;
    const cols = i1 - i0 + 1;
    const rows = j1 - j0 + 1;
    const positions = new Float32Array(cols * rows * 3);
    const nodes = new Int32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = r * cols + c;
        positions[v * 3] = (i0 + c - nx / 2) * dx;
        positions[v * 3 + 1] = (j0 + r - ny / 2) * dx;
        positions[v * 3 + 2] = h + 0.2;
        nodes[v] = (j0 + r) * nx + (i0 + c);
      }
    }
    const index: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        index.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols * rows * 3), 3));
    geometry.setIndex(index);
    this.fieldNodes = nodes;
    this.scratch = new Float32Array(nx * ny);
    this.fieldPlot = new THREE.Mesh(
      geometry,
      // toneMapped off: the colour scale must render as defined, not compressed by the scene's tone curve.
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false }),
    );
    // The plot moves (relief) but never leaves this sphere, so it is set once instead of recomputed per frame.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, h), Math.hypot(dsl.ground.w_mm, dsl.ground.l_mm) / 2 + 10);
    this.fieldPlot.visible = this.fields !== null;
    this.board.add(this.fieldPlot);
    this.fieldDirty = true;
  }

  setFields(fields: FieldSolution): void {
    this.fields = fields;
    this.magnitude = phasorMagnitude(fields.substrateEz);
    // Reference = 99th percentile over the plotted area. The probe cell is a
    // near-singularity; scaling to it would leave the cavity field invisible.
    const sample = Array.from(this.fieldNodes, (n) => this.magnitude![n]).sort((a, b) => a - b);
    this.reference = sample[Math.floor(0.99 * (sample.length - 1))];
    if (!(this.reference > 0)) throw new Error('field plot: the solved field is zero over the board');
    if (this.fieldPlot) this.fieldPlot.visible = true;
    this.buildBalloon();
    this.fieldDirty = true;
  }

  /** Call after changing `mode` or `relief`. */
  refreshField(): void {
    this.fieldDirty = true;
  }

  legend(): FieldLegend | null {
    if (!this.fields) return null;
    const f = `${this.fields.frequencyGHz.toFixed(2)} GHz`;
    return this.mode === 'magnitude'
      ? { title: `|Ez| in the substrate at ${f}`, scaleCss: scaleCss(MAGNITUDE_SCALE), ticks: [`−${MAGNITUDE_RANGE_DB} dB`, `−${MAGNITUDE_RANGE_DB / 2} dB`, '0 dB'] }
      : { title: `Ez in the substrate at ${f}, phase animated`, scaleCss: scaleCss(SIGNED_SCALE), ticks: ['−1', '0', '+1'] };
  }

  set showFarField(visible: boolean) {
    this.balloonVisible = visible;
    if (this.balloon) this.balloon.visible = visible;
  }
  private balloonVisible = false;

  private buildBalloon(): void {
    if (!this.fields) return;
    if (this.balloon) {
      disposeDeep(this.balloon);
      this.board.remove(this.balloon);
    }
    const { thetaDeg, phiDeg, gainDbi, peakDbi } = this.fields.farField;
    const nt = thetaDeg.length;
    const np = phiDeg.length;
    const positions = new Float32Array(nt * (np + 1) * 3);
    const colors = new Float32Array(nt * (np + 1) * 3);
    for (let t = 0; t < nt; t++) {
      const theta = (thetaDeg[t] * Math.PI) / 180;
      for (let p = 0; p <= np; p++) {
        const phi = (2 * Math.PI * p) / np;
        const level = (gainDbi[t * np + (p % np)] - (peakDbi - BALLOON_RANGE_DB)) / BALLOON_RANGE_DB;
        const radius = BALLOON_MM * Math.max(0, level);
        const v = t * (np + 1) + p;
        positions[v * 3] = radius * Math.sin(theta) * Math.cos(phi);
        positions[v * 3 + 1] = radius * Math.sin(theta) * Math.sin(phi);
        positions[v * 3 + 2] = radius * Math.cos(theta);
        colors.set(MAGNITUDE_LUT.subarray(lutIndex(level), lutIndex(level) + 3), v * 3);
      }
    }
    const index: number[] = [];
    for (let t = 0; t < nt - 1; t++) {
      for (let p = 0; p < np; p++) {
        const a = t * (np + 1) + p;
        index.push(a, a + np + 1, a + 1, a + 1, a + np + 1, a + np + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(index);
    const surface = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
      }),
    );
    const mesh = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 }),
    );
    this.balloon = new THREE.Group();
    this.balloon.add(surface, mesh);
    this.balloon.position.z = this.boardTopMm + 2;
    this.balloon.visible = this.balloonVisible;
    this.board.add(this.balloon);
  }

  /** Orbit the camera to an exact azimuth. Used by the screenshot and video capture scripts. */
  setOrbit(azimuthRad: number): void {
    this.controls.autoRotate = false;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const radius = Math.hypot(offset.x, offset.y);
    this.camera.position.set(target.x + radius * Math.cos(azimuthRad), target.y + radius * Math.sin(azimuthRad), this.camera.position.z);
    this.camera.lookAt(target);
  }

  private advance(nowMs: number): void {
    const dt = Math.min(0.1, (nowMs - this.lastFrameMs) / 1000);
    this.lastFrameMs = nowMs;
    if (!this.fields) return;
    if (this.animatePhase && this.mode === 'instantaneous') {
      this.phaseRad = (this.phaseRad + 2 * Math.PI * this.phaseCyclesPerSecond * dt) % (2 * Math.PI);
      this.fieldDirty = true;
    }
    if (this.fieldDirty) this.paintField();
  }

  /** Recolour (and in relief mode, displace) the field plot for the current mode and phase. */
  private paintField(): void {
    if (!this.fields || !this.fieldPlot || !this.magnitude) return;
    this.fieldDirty = false;
    const geometry = this.fieldPlot.geometry;
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const col = geometry.attributes.color as THREE.BufferAttribute;
    const positions = pos.array as Float32Array;
    const colors = col.array as Float32Array;
    const instantaneous = this.mode === 'instantaneous';
    if (instantaneous) instantaneousField(this.fields.substrateEz, this.phaseRad, this.scratch);
    const lut = instantaneous ? SIGNED_LUT : MAGNITUDE_LUT;
    const baseZ = this.boardTopMm + 0.2 + (this.relief ? RELIEF_LIFT_MM : 0);
    for (let v = 0; v < this.fieldNodes.length; v++) {
      const node = this.fieldNodes[v];
      let level: number;
      let height = 0;
      if (instantaneous) {
        const signed = Math.max(-1, Math.min(1, this.scratch[node] / this.reference));
        level = (signed + 1) / 2;
        if (this.relief) height = signed * RELIEF_MM;
      } else {
        const db = 20 * Math.log10(Math.max(1e-9, this.magnitude[node] / this.reference));
        level = 1 + Math.min(0, db) / MAGNITUDE_RANGE_DB;
      }
      const at = lutIndex(level);
      colors[v * 3] = lut[at];
      colors[v * 3 + 1] = lut[at + 1];
      colors[v * 3 + 2] = lut[at + 2];
      positions[v * 3 + 2] = baseZ + height;
    }
    col.needsUpdate = true;
    pos.needsUpdate = true;
  }
}

/** Line segments along every edge between a copper and a bare cell. */
function copperOutline(mask: Uint8Array, nx: number, ny: number, dx: number, z: number): THREE.LineSegments {
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < nx && j < ny ? mask[i + nx * j] : 0);
  const x = (i: number) => (i - nx / 2) * dx;
  const y = (j: number) => (j - ny / 2) * dx;
  const points: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!at(i, j)) continue;
      if (!at(i - 1, j)) points.push(x(i), y(j), z, x(i), y(j + 1), z);
      if (!at(i + 1, j)) points.push(x(i + 1), y(j), z, x(i + 1), y(j + 1), z);
      if (!at(i, j - 1)) points.push(x(i), y(j), z, x(i + 1), y(j), z);
      if (!at(i, j + 1)) points.push(x(i), y(j + 1), z, x(i + 1), y(j + 1), z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.85 }));
}

function disposeDeep(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}
