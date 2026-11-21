/**
 * The workbench's 3D view of the project: the board as it would sit on a
 * bench (laminate, gold copper, the lumped ports), the solve box, the mesh,
 * and after a solve the field on the board and the radiation lobe.
 *
 * Units: 1 scene unit = 1 mm, z up, z = 0 at the bottom of the stackup.
 * Copper is drawn from the project's own polygons, painted in file order and
 * clipped to the board, so cuts and overlaps look the way the solver reads
 * them. Grid snapping is not shown here; turn on Mesh to see the cells.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { PmlFaces } from '../engine/cpml';
import type { MeshLines } from '../engine/mesh';
import type { ResolvedProject, Vec2 } from '../project/resolve';
import { linearLut, MAGNITUDE_SCALE, scaleCss } from '../viewer/colormap';
import { lobeMesh } from '../viewer/lobe_mesh';
import type { Selection } from './selection';
import { DrawTool, type Drawn } from './draw_tool';
import { copperLayerZ, type FarFieldSummary, type FieldMaps, type FieldVolume } from './solve';
import {
  cutComponent, cutGrid, cutPositions, cutRange, cutVector, isMagnitude, magnitude, nearestCutIndex, planeLabel, quantityLabel,
  type ComplexGrid, type CutAxis, type CutQuantity, type FieldCut,
} from './field_cut';

export type FieldMode = 'none' | 'ez' | 'current' | 'cut';

/** What Cut mode draws: a field on a node plane of the solve box, optionally with arrows of its vector in the plane. */
export interface CutSettings extends FieldCut {
  quantity: CutQuantity;
  arrows: boolean;
}

/** The field sheet's nodes (a fastest), where each sits, and either a phasor or a magnitude per node. */
interface SheetData {
  cols: number;
  rows: number;
  at: (a: number, b: number) => [number, number, number];
  phasor?: ComplexGrid;
  magnitude?: Float32Array;
  arrows?: { u: ComplexGrid; v: ComplexGrid; uAxis: CutAxis; vAxis: CutAxis };
}

export type CameraPreset = 'iso' | 'top' | 'side';

export interface FieldLegend {
  title: string;
  scaleCss: string;
  low: string;
  high: string;
}

/** Signed field colours, matched to the launch video's renders. */
const POSITIVE = new THREE.Color('#e85c3a');
const NEGATIVE = new THREE.Color('#4884e8');
const MAGNITUDE_RANGE_DB = 30;
/** Opacity of the board while a cut is shown through it. */
const GHOST_OPACITY = 0.18;
/** About this many arrows along the longer side of a cut. */
const ARROWS_ACROSS = 22;
const ARROW_COLOUR = 0xeef3f8;
const LOBE_RANGE_DB = 30;
const MAGNITUDE_LUT = linearLut(MAGNITUDE_SCALE);
/** Normalise fields to this percentile of |phasor|, so the singular port cell does not set the scale. */
const NORMALISE_PERCENTILE = 0.98;
const ACCENT = 0x62cde8;
const TEXTURE_PIXELS = 2048;
/** Seconds per field cycle while playing; slow enough to follow a crest across the board. */
export const PHASE_CYCLE_S = 2;

/** Laminate colour from the permittivity: glass-epoxy green around FR-4, ceramic cream around Rogers, grey otherwise. */
function laminateColour(epsR: number): number {
  if (epsR >= 3.9 && epsR <= 4.9) return 0x0a2616;
  if (epsR >= 2.8 && epsR < 3.9) return 0xb9ab8c;
  return 0x4a5058;
}

export class ModelView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
  private readonly controls: OrbitControls;
  private readonly board = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly mat: THREE.Mesh;
  private domain: THREE.Group | null = null;
  private meshLines: THREE.LineSegments | null = null;
  private meshed: { mesh: MeshLines; pml: PmlFaces } | null = null;
  private fieldSheet: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  private lobe: THREE.Mesh | null = null;
  private highlight: THREE.Object3D | null = null;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private dirty = true;
  private resolved: ResolvedProject | null = null;
  /** What drawn shapes line up with (DrawTool): ends of straight axis-aligned edges of added copper and the outline. */
  private snapCorners: Vec2[] = [];
  private copperZ = new Map<string, number>();
  private stackTop = 0;
  /** Copper planes for picking: one per layer, top first. */
  private copperPlanes: Array<{ layer: string; mesh: THREE.Mesh }> = [];
  private portMeshes: THREE.Mesh[] = [];
  /** One chip body per lumped component, in project order. */
  private componentMeshes: THREE.Mesh[] = [];
  /** One barrel per via (a fence has one per via), each tagged with its project index. */
  private viaMeshes: THREE.Mesh[] = [];
  private fields: FieldMaps | null = null;
  private fieldIndex = 0;
  private fieldMode: FieldMode = 'none';
  private cut: CutSettings | null = null;
  /** Whether the board is see-through for a cut on screen. */
  private ghosted = false;
  private sheet: SheetData | null = null;
  private arrowMesh: THREE.InstancedMesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null = null;
  private arrowNodes: { nodes: number[]; reference: number } | null = null;
  /** Phase of the drawn instant, Re{F e^{j phase}}, in radians; every signed field reads it. */
  private phase = 0;
  /** Whether the phase sweeps on its own. Off at start for reduced motion; the play button still starts it. */
  private playing = !this.reducedMotion;
  /** Called whenever the phase of a phased field moves, by playback or by setPhase. */
  onPhaseChange: (phase: number) => void = () => {};
  /** Normalising level of the field on screen: the 98th percentile of |phasor| or of the magnitude. */
  private fieldReference = 1;
  private lastFrameMs = 0;
  private fitted = false;
  showDomain = true;

  constructor(
    private readonly host: HTMLElement,
    /** A click on copper or a port: the tree key of what was hit. */
    private readonly onPick: (key: string) => void,
    /** A shape or port drawn with a draw tool, and the snapped board point under the pointer while one is active. */
    drawing: { onDrawn: (drawn: Drawn) => boolean; onCursor: (at: Vec2 | null) => void },
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;

    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => (this.dirty = true));

    // Warm key from the front left, cool rim from behind: the bench look of the launch renders.
    const key = new THREE.DirectionalLight(0xffe4c8, 2.0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    const rim = new THREE.DirectionalLight(0xa8ccff, 1.3);
    this.scene.add(key, key.target, rim, new THREE.HemisphereLight(0xdfe8ff, 0x1a1c20, 0.35));
    this.lights = { key, rim };

    this.mat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 1, metalness: 0, envMapIntensity: 0.1 }));
    this.mat.receiveShadow = true;
    this.scene.add(this.mat, this.board, this.overlay);

    this.renderer.domElement.addEventListener('pointerdown', (e) => (this.pointerDown = [e.clientX, e.clientY]));
    this.renderer.domElement.addEventListener('pointerup', (e) => this.onPointerUp(e));

    this.draw = new DrawTool({
      element: host, camera: this.camera, overlay: this.overlay,
      layerZ: (layer) => this.copperZ.get(layer), redraw: () => (this.dirty = true),
      corners: () => this.snapCorners,
    }, drawing.onDrawn, drawing.onCursor);

    // Turning reduced motion on stops playback; the play button can still start it.
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => e.matches && this.setPlaying(false));
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = (nowMs: number) => {
      this.advance(nowMs);
      if (this.controls.update()) this.dirty = true;
      if (this.dirty) {
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private lights: { key: THREE.DirectionalLight; rim: THREE.DirectionalLight };
  readonly draw: DrawTool;
  private pointerDown: [number, number] = [0, 0];

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (w === 0 || h === 0) return;
    this.viewVersion++;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /* ---------------------------------------------------------------- model */

  setProject(r: ResolvedProject): void {
    this.viewVersion++;
    this.resolved = r;
    this.snapCorners = alignedEdgeEnds([r.boardOutline, ...Object.values(r.copper).flatMap((shapes) => shapes.filter((s) => s.op === 'add').map((s) => s.polygon))]);
    this.copperZ = copperLayerZ(r);
    clear(this.board);
    this.copperPlanes = [];
    this.portMeshes = [];
    this.componentMeshes = [];
    this.viaMeshes = [];
    const outline = new THREE.Shape(r.boardOutline.map(([x, y]) => new THREE.Vector2(x, y)));

    let z = 0;
    for (const layer of r.stackup) {
      if (layer.type !== 'dielectric') continue;
      const thickness = r.graded ? layer.thicknessMm : Math.round(layer.thicknessMm / r.cellMm) * r.cellMm;
      const geometry = new THREE.ExtrudeGeometry(outline, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
      const cap = new THREE.MeshPhysicalMaterial({ color: laminateColour(layer.epsR), roughness: 0.7, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 0.35 });
      const edge = new THREE.MeshStandardMaterial({ color: 0xc9b48a, roughness: 0.8 });
      const slab = new THREE.Mesh(geometry, [cap, edge]);
      slab.position.z = z;
      slab.castShadow = slab.receiveShadow = true;
      this.board.add(slab);
      z += thickness;
    }
    this.stackTop = z;

    const [minX, minY, maxX, maxY] = bounds(r.boardOutline);
    const copperNames = [...this.copperZ.keys()];
    copperNames.forEach((name, n) => {
      const shapes = r.copper[name] ?? [];
      if (!shapes.some((s) => s.op === 'add')) return;
      const texture = copperMask(shapes, r.boardOutline, [minX, minY, maxX, maxY]);
      const exposed = n === 0 || n === copperNames.length - 1;
      const material = new THREE.MeshPhysicalMaterial({
        color: exposed ? 0xd9ad55 : 0xc77d4a, metalness: 1, roughness: 0.24, alphaMap: texture, alphaTest: 0.5, side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxY - minY), material);
      // Copper sheets have no thickness; lift the outer ones off the laminate so they never z-fight.
      const lift = n === copperNames.length - 1 ? 0.012 : n === 0 ? -0.012 : 0;
      plane.position.set((minX + maxX) / 2, (minY + maxY) / 2, this.copperZ.get(name)! + lift);
      plane.receiveShadow = true;
      this.board.add(plane);
      this.copperPlanes.unshift({ layer: name, mesh: plane });
    });

    r.ports.forEach((port, index) => {
      const [za, zb] = port.between.map((name) => this.copperZ.get(name) ?? 0).sort((a, b) => a - b);
      const height = Math.max(0.05, zb - za);
      const radius = Math.max(0.12, Math.min(maxX - minX, maxY - minY) / 120);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 20), new THREE.MeshStandardMaterial({ color: 0xec6b62, emissive: 0x5a1410, roughness: 0.4 }));
      pin.rotation.x = Math.PI / 2;
      pin.position.set(port.xMm, port.yMm, (za + zb) / 2);
      pin.userData.portIndex = index;
      this.board.add(pin);
      this.portMeshes.push(pin);
      const label = textSprite(String(index + 1));
      label.position.set(port.xMm, port.yMm, zb + radius * 6);
      label.scale.setScalar(radius * 8);
      this.board.add(label);
    });

    // Components: a dark chip body, as an SMD part looks. On a layer it spans the gap and sits on the copper;
    // between layers it is a thin post through the board.
    const post = Math.max(0.12, Math.min(maxX - minX, maxY - minY) / 120);
    r.components.forEach((component, index) => {
      const { place } = component;
      let box: THREE.BoxGeometry;
      const at = new THREE.Vector3();
      if (place.kind === 'layer') {
        const length = place.toMm - place.fromMm;
        const across = place.widthMm ?? Math.max(2 * post, length / 2);
        const height = Math.max(0.1, Math.min(length, across) / 3);
        box = place.axis === 0 ? new THREE.BoxGeometry(length, across, height) : new THREE.BoxGeometry(across, length, height);
        const mid = (place.fromMm + place.toMm) / 2;
        // On the outside of the board: above a top layer, below a bottom one.
        const copperZ = this.copperZ.get(place.layer) ?? 0;
        const z = copperZ + (copperZ >= this.stackTop / 2 ? 1 : -1) * (height / 2 + 0.012);
        at.set(place.axis === 0 ? mid : place.acrossMm, place.axis === 0 ? place.acrossMm : mid, z);
      } else {
        const [za, zb] = place.between.map((name) => this.copperZ.get(name) ?? 0).sort((a, b) => a - b);
        box = new THREE.BoxGeometry(2 * post, 2 * post, Math.max(0.05, zb - za));
        at.set(place.xMm, place.yMm, (za + zb) / 2);
      }
      const body = new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.55, metalness: 0.1 }));
      body.position.copy(at);
      body.castShadow = true;
      body.userData.componentIndex = index;
      this.board.add(body);
      this.componentMeshes.push(body);
    });

    // Vias: plated barrels, copper colored, at the drill's diameter (never thinner than a hairline on screen).
    const viaMaterial = new THREE.MeshStandardMaterial({ color: 0xc8895a, roughness: 0.35, metalness: 0.8 });
    for (const via of r.vias) {
      const [za, zb] = via.between.map((name) => this.copperZ.get(name) ?? 0).sort((a, b) => a - b);
      const radius = Math.max(via.radiusMm, post / 3);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(0.05, zb - za) + 0.02, 16), viaMaterial);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(via.xMm, via.yMm, (za + zb) / 2);
      barrel.userData.viaIndex = via.index;
      this.board.add(barrel);
      this.viaMeshes.push(barrel);
    }

    const size = Math.max(maxX - minX, maxY - minY);
    this.mat.scale.set(size * 12, size * 12, 1);
    this.mat.position.set((minX + maxX) / 2, (minY + maxY) / 2, -0.02);
    this.lights.key.position.set(minX - size * 1.2, minY - size * 1.8, this.stackTop + size * 2.2);
    this.lights.key.target.position.set((minX + maxX) / 2, (minY + maxY) / 2, 0);
    const shadow = this.lights.key.shadow.camera;
    shadow.left = shadow.bottom = -size * 1.5;
    shadow.right = shadow.top = size * 1.5;
    shadow.near = 0.1;
    shadow.far = size * 8;
    shadow.updateProjectionMatrix();
    this.lights.rim.position.set((minX + maxX) / 2 + size, maxY + size * 2, this.stackTop + size);

    // New board materials start solid; ghost them again if a cut is on screen.
    if (this.ghosted) {
      this.ghosted = false;
      this.ghostBoard(true);
    }
    this.drawDomain();
    if (!this.fitted) {
      this.setCamera('iso');
      this.fitted = true;
    }
    this.dirty = true;
  }

  /** The solve box: air around the board out to the boundaries, and the PML beyond it. */
  private drawDomain(): void {
    if (this.domain) this.overlay.remove(this.domain);
    this.domain = null;
    const r = this.resolved;
    if (!r || !this.showDomain) return;
    type Box = [number, number, number, number, number, number];
    let air: Box;
    let outer: Box;
    if (this.meshed) {
      // The meshed extents, when known: rasterise widens the air where a coax port reaches past the board.
      const { mesh, pml } = this.meshed;
      const end = (a: Float64Array, high: number) => a[a.length - 1 - high];
      air = [mesh.x[pml.xLow], mesh.y[pml.yLow], mesh.z[pml.zLow], end(mesh.x, pml.xHigh), end(mesh.y, pml.yHigh), end(mesh.z, pml.zHigh)];
      outer = [mesh.x[0], mesh.y[0], mesh.z[0], end(mesh.x, 0), end(mesh.y, 0), end(mesh.z, 0)];
    } else {
      const [minX, minY, maxX, maxY] = bounds(r.boardOutline);
      const m = r.airMarginCells;
      const c = r.cellMm;
      air = [minX - m.xy * c, minY - m.xy * c, -m.below * c, maxX + m.xy * c, maxY + m.xy * c, this.stackTop + m.above * c];
      const pml = (face: keyof ResolvedProject['boundaries']) => (r.boundaries[face].type === 'pml' ? (r.boundaries[face] as { cells: number }).cells * c : 0);
      outer = [air[0] - pml('x_min'), air[1] - pml('y_min'), air[2] - pml('z_min'), air[3] + pml('x_max'), air[4] + pml('y_max'), air[5] + pml('z_max')];
    }
    const group = new THREE.Group();
    group.add(boxLines(air, 0x9ba3af, 0.55), boxLines(outer, 0x9ba3af, 0.18));
    this.domain = group;
    this.overlay.add(group);
    this.dirty = true;
  }

  setShowDomain(on: boolean): void {
    this.showDomain = on;
    this.drawDomain();
  }

  /**
   * The rasterised mesh: the solve box is drawn from its extents, and with
   * showLines its lines on the top copper plane inside the PML. Null clears both.
   */
  setMesh(mesh: MeshLines | null, pml: PmlFaces | null = null, showLines = true): void {
    this.meshed = mesh ? { mesh, pml: pml ?? { xLow: 0, xHigh: 0, yLow: 0, yHigh: 0, zLow: 0, zHigh: 0 } } : null;
    this.drawDomain();
    if (this.meshLines) {
      this.overlay.remove(this.meshLines);
      this.meshLines.geometry.dispose();
      this.meshLines = null;
    }
    if (mesh && showLines) {
      const z = this.stackTop + 0.03;
      const points: number[] = [];
      const xs = mesh.x.subarray(pml?.xLow ?? 0, mesh.x.length - (pml?.xHigh ?? 0));
      const ys = mesh.y.subarray(pml?.yLow ?? 0, mesh.y.length - (pml?.yHigh ?? 0));
      const [x0, x1, y0, y1] = [xs[0], xs.at(-1)!, ys[0], ys.at(-1)!];
      for (const x of xs) points.push(x, y0, z, x, y1, z);
      for (const y of ys) points.push(x0, y, z, x1, y, z);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      this.meshLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xe9ebef, transparent: true, opacity: 0.22, depthWrite: false }));
      this.overlay.add(this.meshLines);
    }
    this.dirty = true;
  }

  setSelection(selection: Selection | null): void {
    if (this.highlight) this.overlay.remove(this.highlight);
    this.highlight = null;
    const r = this.resolved;
    if (r && selection?.kind === 'shape') {
      const shape = r.copper[selection.layer]?.[selection.index];
      const z = this.copperZ.get(selection.layer);
      if (shape && z !== undefined) this.highlight = outlineLoop(shape.polygon, z + (z >= this.stackTop ? 0.03 : -0.03));
    } else if (r && selection?.kind === 'port') {
      const port = this.portMeshes[selection.index];
      if (port) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry((port.geometry as THREE.CylinderGeometry).parameters.radiusTop * 3, 0.04, 8, 40),
          new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false }));
        ring.position.set(port.position.x, port.position.y, this.stackTop + 0.05);
        ring.renderOrder = 10;
        this.highlight = ring;
      }
    } else if (r && selection?.kind === 'component') {
      const body = this.componentMeshes[selection.index];
      if (body) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false }));
        edges.position.copy(body.position);
        edges.scale.setScalar(1.15);
        edges.renderOrder = 10;
        this.highlight = edges;
      }
    } else if (r && selection?.kind === 'via') {
      const group = new THREE.Group();
      for (const barrel of this.viaMeshes.filter((m) => m.userData.viaIndex === selection.index)) {
        const radius = (barrel.geometry as THREE.CylinderGeometry).parameters.radiusTop;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 2.2, 0.03, 8, 32), new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false }));
        ring.position.set(barrel.position.x, barrel.position.y, this.stackTop + 0.05);
        ring.renderOrder = 10;
        group.add(ring);
      }
      this.highlight = group;
    }
    if (this.highlight) this.overlay.add(this.highlight);
    this.dirty = true;
  }

  setCamera(preset: CameraPreset): void {
    const r = this.resolved;
    if (!r) return;
    const [minX, minY, maxX, maxY] = bounds(r.boardOutline);
    const centre = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, this.stackTop / 2);
    const size = Math.max(maxX - minX, maxY - minY, this.stackTop);
    const distance = (size * 1.25) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const direction = { iso: new THREE.Vector3(-0.45, -0.75, 0.62), top: new THREE.Vector3(0, -0.0001, 1), side: new THREE.Vector3(0, -1, 0.06) }[preset].normalize();
    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(direction, distance * 0.62);
    this.camera.near = size / 200;
    this.camera.far = size * 200;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private onPointerUp(e: PointerEvent): void {
    if (Math.hypot(e.clientX - this.pointerDown[0], e.clientY - this.pointerDown[1]) > 4) return; // a drag, not a click
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const portHit = ray.intersectObjects(this.portMeshes)[0];
    if (portHit) return this.onPick(`port:${portHit.object.userData.portIndex}`);
    const componentHit = ray.intersectObjects(this.componentMeshes)[0];
    if (componentHit) return this.onPick(`component:${componentHit.object.userData.componentIndex}`);
    const viaHit = ray.intersectObjects(this.viaMeshes)[0];
    if (viaHit) return this.onPick(`via:${viaHit.object.userData.viaIndex}`);
    const r = this.resolved;
    if (!r) return;
    // Nearest copper sheet first. Bare laminate is opaque, so a miss on the board stops the ray there.
    const hits = this.copperPlanes
      .map(({ layer, mesh }) => ({ layer, hit: ray.intersectObject(mesh)[0] }))
      .filter((h) => h.hit)
      .sort((a, b) => a.hit.distance - b.hit.distance);
    for (const { layer, hit } of hits) {
      const shapes = r.copper[layer];
      // The last shape painted at this point decides what is there.
      for (let n = shapes.length - 1; n >= 0; n--) {
        if (insidePolygon(shapes[n].polygon, hit.point.x, hit.point.y)) return this.onPick(`shape:${layer}:${n}`);
      }
      if (insidePolygon(r.boardOutline, hit.point.x, hit.point.y)) return;
    }
  }

  /* ---------------------------------------------------------------- results */

  setResults(fields: FieldMaps | null, farField: FarFieldSummary | null): void {
    this.viewVersion++;
    // A cut keeps its plane, quantity and position (in mm) across solves.
    const keptAtMm = this.fields?.volume && this.cut ? cutGrid(this.fields, this.fields.volume, this.cut).atMm : null;
    this.fields = fields;
    this.fieldIndex = 0;
    const volume = fields?.volume ?? null;
    if (fields && volume) {
      const axis = this.cut?.axis ?? 'z';
      const index = keptAtMm === null ? this.defaultCutIndex(fields, volume, axis) : nearestCutIndex(fields, volume, axis, keptAtMm);
      this.cut = { quantity: 'ez', arrows: false, ...this.cut, axis, index };
    }
    this.buildFieldSheet();
    this.setLobe(farField);
  }

  setFieldMode(mode: FieldMode): void {
    this.viewVersion++;
    this.fieldMode = mode;
    this.buildFieldSheet();
  }

  setFieldFrequency(index: number): void {
    this.viewVersion++;
    this.fieldIndex = index;
    this.buildFieldSheet();
  }

  /** The cut the Cut mode draws, or null before a solve that kept the field volume. */
  get cutSettings(): CutSettings | null {
    return this.cutHasData() ? this.cut : null;
  }

  /** The cut's position as an index into cutPositions(its axis), or null without a field volume. */
  get cutPosition(): number | null {
    const fields = this.fields;
    const cut = this.cutSettings;
    return fields?.volume && cut ? cut.index - cutRange(fields, fields.volume, cut.axis).first : null;
  }

  /** Node positions (mm) a cut along `axis` can take, or null without a field volume. */
  cutPositions(axis: CutAxis): Float64Array | null {
    const fields = this.fields;
    if (!fields?.volume) return null;
    return cutPositions(cutRange(fields, fields.volume, axis));
  }

  /**
   * Changes the cut. A new axis without a position starts through the first
   * port (XZ, YZ) or mid-substrate (XY); `position` counts nodes from the
   * first one inside the PML, as cutPositions lists them.
   */
  setCut(change: { axis?: CutAxis; position?: number; quantity?: CutQuantity; arrows?: boolean }): void {
    const fields = this.fields;
    const cut = this.cut;
    if (!fields?.volume || !cut) return;
    const axis = change.axis ?? cut.axis;
    const first = cutRange(fields, fields.volume, axis).first;
    const index = change.position !== undefined ? first + change.position
      : axis !== cut.axis ? this.defaultCutIndex(fields, fields.volume, axis) : cut.index;
    this.viewVersion++;
    this.cut = { axis, index, quantity: change.quantity ?? cut.quantity, arrows: change.arrows ?? cut.arrows };
    this.buildFieldSheet();
  }

  private defaultCutIndex(fields: FieldMaps, volume: FieldVolume, axis: CutAxis): number {
    const port = this.resolved?.ports[0];
    const at = axis === 'z' ? fields.ezZMm : axis === 'x' ? port?.xMm : port?.yMm;
    if (at !== undefined) return nearestCutIndex(fields, volume, axis, at);
    const { first, last } = cutRange(fields, volume, axis);
    return Math.round((first + last) / 2);
  }

  /** In Cut mode the board turns see-through, so a cut inside or under it shows. */
  private ghostBoard(on: boolean): void {
    if (on === this.ghosted) return;
    this.ghosted = on;
    this.mat.visible = !on;
    this.board.traverse((object) => {
      // Port labels are sprites and stay readable.
      if (!(object instanceof THREE.Mesh)) return;
      const mesh = object;
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        const solid = (material.userData.solid ??= { transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite, alphaTest: material.alphaTest });
        material.transparent = on || solid.transparent;
        material.opacity = on ? GHOST_OPACITY : solid.opacity;
        material.depthWrite = on ? false : solid.depthWrite;
        // Copper is cut out by an alpha test; keep its outline at the ghost opacity.
        material.alphaTest = on && solid.alphaTest > 0 ? GHOST_OPACITY / 2 : solid.alphaTest;
        material.needsUpdate = true;
      }
    });
    this.dirty = true;
  }

  private lobeVisible = false;
  private farField: FarFieldSummary | null = null;

  setLobeVisible(on: boolean): void {
    this.lobeVisible = on;
    this.setLobe(this.farField);
  }

  /** The far-field result the lobe shows (the far-field view's frequency). */
  setLobe(farField: FarFieldSummary | null): void {
    this.farField = farField;
    if (this.lobe) {
      this.overlay.remove(this.lobe);
      this.lobe.geometry.dispose();
      this.lobe = null;
    }
    const r = this.resolved;
    if (farField && this.lobeVisible && r) {
      const f = farField.result;
      const mesh = lobeMesh(f.thetaDeg, f.phiDeg, f.directivityDbi, LOBE_RANGE_DB);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      geometry.computeVertexNormals();
      // Opaque: a see-through shell reads as a bubble and hides the shape. Turn it off to see the board.
      this.lobe = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
      const [minX, minY, maxX, maxY] = bounds(r.boardOutline);
      // Peak at half a board width; the lobe sits on the board's centre like the pattern of a point source there.
      this.lobe.scale.setScalar(0.5 * Math.max(maxX - minX, maxY - minY));
      this.lobe.position.set((minX + maxX) / 2, (minY + maxY) / 2, this.stackTop + 0.05);
      this.lobe.castShadow = true;
      this.overlay.add(this.lobe);
    }
    this.dirty = true;
  }

  /** Legend for the field on screen, or null. */
  legend(): FieldLegend | null {
    const fields = this.fields;
    if (!fields || this.fieldMode === 'none') return null;
    const f = fields.planes[this.fieldIndex].frequencyGHz;
    const signed = { scaleCss: `linear-gradient(to top, ${NEGATIVE.getStyle()}, #1a1c20 50%, ${POSITIVE.getStyle()})`, low: '−', high: '+' };
    const magnitude = { scaleCss: scaleCss(MAGNITUDE_SCALE), low: `−${MAGNITUDE_RANGE_DB} dB`, high: '0 dB = 98th percentile' };
    if (this.fieldMode === 'current') return { title: `Surface current |J| on ${fields.copperLayer}, ${f} GHz`, ...magnitude };
    if (this.fieldMode === 'ez') return { title: `Ez in ${fields.ezLayer}, ${f} GHz, drawn above the board`, ...signed };
    const cut = this.cutSettings;
    if (!cut) {
      return { title: fields.volumeSkipped ?? 'This solve kept no field volume for cuts.', scaleCss: 'none', low: '', high: '' };
    }
    const at = cutGrid(fields, fields.volume!, cut).atMm;
    const arrows = cut.arrows ? `, arrows ${cut.quantity[0].toUpperCase()} in the plane` : '';
    const title = `${quantityLabel(cut.quantity)} on the ${planeLabel(cut.axis)} cut at ${cut.axis} = ${at.toFixed(2)} mm, ${f} GHz${arrows}`;
    return { title, ...(isMagnitude(cut.quantity) ? magnitude : signed) };
  }

  /** Whether the field volume covers the frequency on screen (it can stop short on a large grid). */
  private cutHasData(): boolean {
    const volume = this.fields?.volume;
    return !!volume && !!this.cut && this.fieldIndex < volume.frequencies;
  }

  /**
   * The sheet's nodes, in order, and the field on them: a complex phasor for
   * signed fields (drawn at the current phase) or a magnitude (drawn in dB).
   */
  private sheetData(): SheetData | null {
    const fields = this.fields;
    if (!fields) return null;
    const plane = fields.planes[this.fieldIndex];
    if (this.fieldMode === 'ez' || this.fieldMode === 'current') {
      const [i0, i1] = [fields.pml.xLow, fields.xMm.length - 1 - fields.pml.xHigh];
      const [j0, j1] = [fields.pml.yLow, fields.yMm.length - 1 - fields.pml.yHigh];
      const cols = i1 - i0 + 1;
      const rows = j1 - j0 + 1;
      const z = this.stackTop + 0.05;
      const nx = fields.xMm.length;
      const pick = (fn: (c: number) => number) => {
        const out = new Float32Array(cols * rows);
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out[i + cols * j] = fn(i0 + i + nx * (j0 + j));
        return out;
      };
      const at = (a: number, b: number): [number, number, number] => [fields.xMm[i0 + a], fields.yMm[j0 + b], z];
      if (this.fieldMode === 'current') {
        const { jx, jy } = plane;
        return { cols, rows, at, magnitude: pick((c) => Math.hypot(jx.re[c], jx.im[c], jy.re[c], jy.im[c])) };
      }
      return { cols, rows, at, phasor: { re: pick((c) => plane.ez.re[c]), im: pick((c) => plane.ez.im[c]) } };
    }
    const cut = this.cut;
    const volume = fields.volume;
    if (this.fieldMode !== 'cut' || !cut || !volume || !this.cutHasData()) return null;
    const grid = cutGrid(fields, volume, cut);
    const at = (a: number, b: number): [number, number, number] => {
      const p = { x: 0, y: 0, z: 0 };
      p[cut.axis] = grid.atMm;
      p[grid.u] = grid.uMm[a];
      p[grid.v] = grid.vMm[b];
      return [p.x, p.y, p.z];
    };
    const sheet: SheetData = { cols: grid.uMm.length, rows: grid.vMm.length, at };
    const family = cut.quantity[0] as 'e' | 'h';
    if (isMagnitude(cut.quantity) || cut.arrows) {
      const vector = cutVector(fields, volume, this.fieldIndex, cut, family);
      if (isMagnitude(cut.quantity)) sheet.magnitude = magnitude(vector);
      else sheet.phasor = vector[cut.quantity[1] as CutAxis];
      if (cut.arrows) sheet.arrows = { u: vector[grid.u], v: vector[grid.v], uAxis: grid.u, vAxis: grid.v };
    } else {
      sheet.phasor = cutComponent(fields, volume, this.fieldIndex, cut, cut.quantity);
    }
    return sheet;
  }

  private buildFieldSheet(): void {
    if (this.fieldSheet) {
      this.overlay.remove(this.fieldSheet);
      this.fieldSheet.geometry.dispose();
      this.fieldSheet.material.dispose();
      this.fieldSheet = null;
    }
    if (this.arrowMesh) {
      this.overlay.remove(this.arrowMesh);
      this.arrowMesh.geometry.dispose();
      this.arrowMesh.material.dispose();
      this.arrowMesh.dispose();
      this.arrowMesh = null;
    }
    const sheet = this.fieldMode === 'none' ? null : this.sheetData();
    this.sheet = sheet;
    this.ghostBoard(this.fieldMode === 'cut' && sheet !== null);
    if (!sheet) return void (this.dirty = true);
    const { cols, rows } = sheet;
    const positions = new Float32Array(cols * rows * 3);
    for (let b = 0; b < rows; b++) for (let a = 0; a < cols; a++) positions.set(sheet.at(a, b), 3 * (a + cols * b));
    const index: number[] = [];
    for (let b = 0; b < rows - 1; b++) {
      for (let a = 0; a < cols - 1; a++) {
        const n = a + cols * b;
        index.push(n, n + 1, n + cols, n + 1, n + cols + 1, n + cols);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols * rows * 4), 4));
    geometry.setIndex(index);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.fieldSheet = new THREE.Mesh(geometry, material);
    this.fieldSheet.renderOrder = 5;
    this.overlay.add(this.fieldSheet);
    const levels = sheet.magnitude ?? Float32Array.from(sheet.phasor!.re, (re, n) => Math.hypot(re, sheet.phasor!.im[n]));
    this.fieldReference = percentile(levels, NORMALISE_PERCENTILE);
    if (sheet.arrows) this.buildArrows(sheet);
    this.colourField();
  }

  /** Cones on every few nodes of the cut, sized and turned each frame from the in-plane field at the current phase. */
  private buildArrows(sheet: SheetData): void {
    const arrows = sheet.arrows!;
    const stride = Math.max(1, Math.round(Math.max(sheet.cols, sheet.rows) / ARROWS_ACROSS));
    const nodes: number[] = [];
    for (let b = Math.floor(stride / 2); b < sheet.rows; b += stride) for (let a = Math.floor(stride / 2); a < sheet.cols; a += stride) nodes.push(a + sheet.cols * b);
    const [first, last] = [sheet.at(0, 0), sheet.at(sheet.cols - 1, sheet.rows - 1)];
    const span = Math.max(...first.map((v, n) => Math.abs(last[n] - v)));
    const length = (0.9 * span) / ARROWS_ACROSS;
    const cone = new THREE.ConeGeometry(length * 0.18, length, 8);
    cone.translate(0, length / 2, 0); // Base on the node, tip along +y.
    const mesh = new THREE.InstancedMesh(cone, new THREE.MeshBasicMaterial({ color: ARROW_COLOUR, toneMapped: false }), nodes.length);
    mesh.renderOrder = 6;
    // Reference over all nodes of the cut, so the arrows scale with the vectors and not with one component.
    const sizes = Float32Array.from(arrows.u.re, (_, n) => Math.hypot(arrows.u.re[n], arrows.u.im[n], arrows.v.re[n], arrows.v.im[n]));
    this.arrowMesh = mesh;
    this.arrowNodes = { nodes, reference: percentile(sizes, NORMALISE_PERCENTILE) };
    this.overlay.add(mesh);
  }

  private placeArrows(sheet: SheetData): void {
    const mesh = this.arrowMesh;
    const arrows = sheet.arrows;
    if (!mesh || !arrows || !this.arrowNodes) return;
    const [cos, sin] = [Math.cos(this.phase), Math.sin(this.phase)];
    const { nodes, reference } = this.arrowNodes;
    const up = new THREE.Vector3(0, 1, 0);
    const direction = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    nodes.forEach((n, instance) => {
      const [a, b] = [n % sheet.cols, Math.floor(n / sheet.cols)];
      const du = arrows.u.re[n] * cos - arrows.u.im[n] * sin;
      const dv = arrows.v.re[n] * cos - arrows.v.im[n] * sin;
      const size = Math.min(1, Math.hypot(du, dv) / reference);
      const d = { x: 0, y: 0, z: 0 };
      d[arrows.uAxis] = du;
      d[arrows.vAxis] = dv;
      direction.set(d.x, d.y, d.z);
      if (direction.lengthSq() > 0) direction.normalize();
      turn.setFromUnitVectors(up, direction.lengthSq() > 0 ? direction : up);
      // Length in proportion to the field; arrows under a twentieth of the reference vanish, so quiet regions stay clear.
      const scale = size < 0.05 ? 0 : size;
      matrix.compose(new THREE.Vector3(...sheet.at(a, b)), turn, new THREE.Vector3(scale, scale, scale));
      mesh.setMatrixAt(instance, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Recolours the field sheet (and turns the arrows) for the current mode, frequency and phase. */
  private colourField(): void {
    const mesh = this.fieldSheet;
    const sheet = this.sheet;
    if (!mesh || !sheet) return;
    const colors = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const out = colors.array as Float32Array;
    const ref = this.fieldReference;
    if (sheet.magnitude) {
      sheet.magnitude.forEach((m, v) => {
        const db = 20 * Math.log10(Math.max(m, 1e-30) / ref);
        const level = Math.min(1, Math.max(0, 1 + db / MAGNITUDE_RANGE_DB));
        const lut = 3 * Math.round(level * 255);
        out.set(MAGNITUDE_LUT.subarray(lut, lut + 3), 4 * v);
        out[4 * v + 3] = level > 0 ? 0.92 : 0;
      });
    } else {
      const { re, im } = sheet.phasor!;
      const [cos, sin] = [Math.cos(this.phase), Math.sin(this.phase)];
      re.forEach((_, v) => {
        const value = Math.max(-1, Math.min(1, (re[v] * cos - im[v] * sin) / ref));
        const colour = value >= 0 ? POSITIVE : NEGATIVE;
        out[4 * v] = colour.r;
        out[4 * v + 1] = colour.g;
        out[4 * v + 2] = colour.b;
        out[4 * v + 3] = Math.min(1, 1.25 * Math.abs(value) ** 0.8);
      });
    }
    colors.needsUpdate = true;
    this.placeArrows(sheet);
    this.dirty = true;
  }

  /** Advances the phase while playing, one cycle every PHASE_CYCLE_S seconds. */
  private advance(nowMs: number): void {
    const dt = this.lastFrameMs ? Math.min(0.1, (nowMs - this.lastFrameMs) / 1000) : 0;
    this.lastFrameMs = nowMs;
    // Nothing to animate while the Model tab or the page is hidden.
    if (!this.playing || !this.fieldHasPhase() || !this.fieldSheet || document.hidden || this.host.clientWidth === 0) return;
    this.setPhase(this.phase + (dt * 2 * Math.PI) / PHASE_CYCLE_S);
  }

  /** Whether the field on screen is a phasor whose instant depends on the phase (a magnitude does not). */
  fieldHasPhase(): boolean {
    if (this.fieldMode === 'ez') return this.fields !== null;
    return this.fieldMode === 'cut' && this.cutHasData() && (!isMagnitude(this.cut!.quantity) || this.cut!.arrows);
  }

  get fieldPhase(): number {
    return this.phase;
  }

  /** Shows the field at this phase, in radians (wrapped into [0, 2 pi)). */
  setPhase(phase: number): void {
    const turn = 2 * Math.PI;
    this.phase = ((phase % turn) + turn) % turn;
    if (!this.fieldHasPhase()) return;
    this.colourField();
    this.onPhaseChange(this.phase);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    this.onPlayingChange(on);
  }

  /** Called when playback starts or stops, including a stop for reduced motion. */
  onPlayingChange: (playing: boolean) => void = () => {};

  /** Bumped by anything that changes what the view shows other than the phase: project, results, field, size. */
  viewVersion = 0;

  /** Turns orbiting with the mouse on or off (off while a clip records, so the camera holds still). */
  setOrbitEnabled(on: boolean): void {
    this.controls.enabled = on;
  }

  /** Draws the scene now, so the canvas holds the current frame before the next animation frame. */
  renderNow(): void {
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }

  /** The canvas, for screenshots. */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }
}

/* ------------------------------------------------------------------ helpers */

function bounds(polygon: Vec2[]): [number, number, number, number] {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function clear(group: THREE.Group): void {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of materials) {
      (m as THREE.MeshStandardMaterial).alphaMap?.dispose();
      (m as THREE.SpriteMaterial).map?.dispose();
      m.dispose();
    }
  });
  group.clear();
}

/** Copper of one layer as an alpha texture over the board's bounding box: adds and cuts painted in order, clipped to the board. */
function copperMask(shapes: ResolvedProject['copper'][string], outline: Vec2[], [minX, minY, maxX, maxY]: [number, number, number, number]): THREE.CanvasTexture {
  const scale = TEXTURE_PIXELS / Math.max(maxX - minX, maxY - minY);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((maxX - minX) * scale));
  canvas.height = Math.max(1, Math.round((maxY - minY) * scale));
  const ctx = canvas.getContext('2d')!;
  const path = (polygon: Vec2[]) => {
    ctx.beginPath();
    polygon.forEach(([x, y], n) => (n ? ctx.lineTo : ctx.moveTo).call(ctx, (x - minX) * scale, (maxY - y) * scale));
    ctx.closePath();
  };
  ctx.fillStyle = '#fff';
  for (const shape of shapes) {
    ctx.globalCompositeOperation = shape.op === 'add' ? 'source-over' : 'destination-out';
    path(shape.polygon);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'destination-in';
  path(outline);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  return texture;
}

function boxLines([x0, y0, z0, x1, y1, z1]: number[], color: number, opacity: number): THREE.LineSegments {
  const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  lines.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return lines;
}

function outlineLoop(polygon: Vec2[], z: number): THREE.LineLoop {
  const geometry = new THREE.BufferGeometry().setFromPoints(polygon.map(([x, y]) => new THREE.Vector3(x, y, z)));
  const loop = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true }));
  loop.renderOrder = 10;
  return loop;
}

function textSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ec6b62';
  ctx.beginPath();
  ctx.arc(32, 32, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0b0b0c';
  ctx.font = '600 36px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.renderOrder = 11;
  return sprite;
}

function insidePolygon(polygon: Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let n = 0, prev = polygon.length - 1; n < polygon.length; prev = n++) {
    const [ax, ay] = polygon[prev];
    const [bx, by] = polygon[n];
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  }
  return inside;
}

function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  const v = sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return v > 0 ? v : 1;
}

/**
 * Ends of the edges that run along x or y. Arc and circle facets are left out: their odd coordinates would
 * pull drawn points off the grid and add mesh lines near the ones they are meant to share.
 */
function alignedEdgeEnds(polygons: Vec2[][]): Vec2[] {
  const ends: Vec2[] = [];
  for (const polygon of polygons) {
    polygon.forEach((a, n) => {
      const b = polygon[(n + 1) % polygon.length];
      if (a[0] === b[0] || a[1] === b[1]) ends.push(a, b);
    });
  }
  return ends;
}
