/**
 * Drawing on the board with the mouse, in the model view: a rectangle by
 * dragging, a polygon by clicking its corners, a port by clicking where it
 * goes. Points land on the chosen copper layer's plane and snap to a grid.
 * While a tool is active it takes the left button from the orbit controls;
 * the wheel still zooms.
 */
import * as THREE from 'three';
import type { Vec2 } from '../project/resolve';

export type DrawToolKind = 'select' | 'rectangle' | 'polygon' | 'port' | 'section';

export type Drawn =
  | { kind: 'rectangle' | 'polygon' | 'section'; layer: string; points: Vec2[] }
  | { kind: 'port'; layer: string; at: Vec2 };

/** Snap step, mm: fine enough for RF traces, coarse enough to land on round numbers. */
export const SNAP_MM = 0.1;
/** A click within this many pixels of the first corner closes the polygon; also the reach of corner snapping. */
const CLOSE_PX = 8;
/**
 * Corner snapping never reaches further than this, however far out the view is zoomed: it is for
 * near-misses of a few grid steps, not for moving a deliberate edge onto a neighbor's.
 */
const SNAP_REACH_MM = 0.5;

export const snap = (v: number, step = SNAP_MM) => Number((Math.round(v / step) * step).toFixed(6));

interface Host {
  element: HTMLElement;
  camera: THREE.Camera;
  overlay: THREE.Group;
  layerZ(layer: string): number | undefined;
  /** Ends of the straight x- and y-aligned edges of copper on every layer and of the board outline, mm. */
  corners(): Vec2[];
  redraw(): void;
}

/**
 * Snaps each coordinate to the nearest existing corner's x or y within
 * `tolerance`, else to the grid. Edges that meet must land on the same
 * coordinate: a 0.1 mm overlap or gap between a hand-drawn feed and patch
 * makes the mesh place lines 0.1 mm apart, and that cell sets the time step
 * for the whole solve (several times slower than the design needs).
 */
export function snapToCorners(at: Vec2, corners: Vec2[], tolerance: Vec2): Vec2 {
  const axis = (value: number, index: 0 | 1) => {
    let best = snap(value);
    let bestDistance = tolerance[index];
    for (const corner of corners) {
      const distance = Math.abs(corner[index] - value);
      if (distance <= bestDistance) {
        best = corner[index];
        bestDistance = distance;
      }
    }
    return best;
  };
  return [axis(at[0], 0), axis(at[1], 1)];
}

export class DrawTool {
  private kind: DrawToolKind = 'select';
  private layer = '';
  private points: Vec2[] = [];
  private cursor: Vec2 | null = null;
  private dragFrom: Vec2 | null = null;
  private readonly preview = new THREE.Group();

  constructor(private readonly host: Host, private readonly onDrawn: (drawn: Drawn) => boolean, private readonly onCursor: (at: Vec2 | null) => void) {
    host.overlay.add(this.preview);
    this.preview.renderOrder = 20;
    // Capture on the host, ahead of the orbit controls on the canvas inside it.
    const capture = { capture: true };
    host.element.addEventListener('pointerdown', (e) => this.onDown(e), capture);
    host.element.addEventListener('pointermove', (e) => this.onMove(e), capture);
    host.element.addEventListener('pointerup', (e) => this.onUp(e), capture);
    host.element.addEventListener('pointercancel', () => this.dragFrom && ((this.dragFrom = null), this.drawPreview()), capture);
    host.element.addEventListener('dblclick', (e) => this.active && (e.stopPropagation(), this.finishPolygon()), capture);
  }

  get active(): boolean {
    return this.kind !== 'select';
  }

  get tool(): DrawToolKind {
    return this.kind;
  }

  set(kind: DrawToolKind, layer: string): void {
    // Choosing the tool already in use keeps the shape in progress.
    if (kind === this.kind && layer === this.layer) return;
    this.kind = kind;
    this.layer = layer;
    this.reset();
    this.host.element.style.cursor = kind === 'select' ? '' : 'crosshair';
  }

  /** Escape: drop the shape in progress, or leave the tool. Enter: close the polygon. Backspace: remove its last corner. */
  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Escape') {
      if (this.points.length || this.dragFrom) this.reset();
      else this.set('select', this.layer);
      return true;
    }
    if (e.key === 'Enter' && this.kind === 'polygon') {
      this.finishPolygon();
      return true;
    }
    if (e.key === 'Backspace' && this.kind === 'polygon' && this.points.length) {
      this.points.pop();
      this.drawPreview();
      return true;
    }
    return false;
  }

  private reset(): void {
    this.points = [];
    this.dragFrom = null;
    this.drawPreview();
  }

  /**
   * The point under the pointer on the drawing layer's plane, snapped, or null off the plane. `toCorners`
   * false snaps to the grid only.
   */
  private boardPoint(e: PointerEvent | MouseEvent, toCorners = true): Vec2 | null {
    const z = this.host.layerZ(this.layer);
    if (z === undefined) return null;
    const rect = this.host.element.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.host.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
    if (!hit) return null;
    // Only shapes line up with corners: a port goes mid-trace, not on its edge. Shift held turns it off, for a
    // feature finer than the snap distance at this zoom.
    // A section boundary goes where the user drags it, on the grid, not onto copper edges.
    const corners = !toCorners || this.kind === 'port' || this.kind === 'section' || e.shiftKey ? [] : this.host.corners();
    // CLOSE_PX on screen, per axis, in mm on the board where the pointer is; never more than SNAP_REACH_MM.
    const reach = (pxPerMm: number) => (pxPerMm > 0 ? Math.min(CLOSE_PX / pxPerMm, SNAP_REACH_MM) : 0);
    return snapToCorners([hit.x, hit.y], corners, [reach(this.pixelsPerMm([hit.x, hit.y], 0)), reach(this.pixelsPerMm([hit.x, hit.y], 1))]);
  }

  /** Screen pixels per mm along the board's x (axis 0) or y (axis 1) at a point on the drawing layer. */
  private pixelsPerMm(at: Vec2, axis: 0 | 1): number {
    const z = this.host.layerZ(this.layer) ?? 0;
    const rect = this.host.element.getBoundingClientRect();
    const a = new THREE.Vector3(at[0], at[1], z).project(this.host.camera);
    const b = new THREE.Vector3(at[0] + (axis === 0 ? 1 : 0), at[1] + (axis === 1 ? 1 : 0), z).project(this.host.camera);
    return Math.hypot(((b.x - a.x) / 2) * rect.width, ((b.y - a.y) / 2) * rect.height);
  }

  private screenDistance(a: Vec2, e: PointerEvent): number {
    const z = this.host.layerZ(this.layer) ?? 0;
    const p = new THREE.Vector3(a[0], a[1], z).project(this.host.camera);
    const rect = this.host.element.getBoundingClientRect();
    return Math.hypot(((p.x + 1) / 2) * rect.width + rect.left - e.clientX, ((1 - p.y) / 2) * rect.height + rect.top - e.clientY);
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    e.stopPropagation();
    // Keep the pointer while the button is down, so a release off the canvas still ends the drag.
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const at = this.boardPoint(e);
    if (at && (this.kind === 'rectangle' || this.kind === 'section')) this.dragFrom = at;
  }

  private onMove(e: PointerEvent): void {
    if (!this.active) return;
    this.cursor = this.boardPoint(e);
    this.onCursor(this.cursor);
    this.drawPreview();
  }

  private onUp(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    e.stopPropagation();
    const at = this.boardPoint(e);
    if (this.kind === 'rectangle' || this.kind === 'section') {
      const kind = this.kind;
      const from = this.dragFrom;
      this.dragFrom = null;
      // A narrow drag whose two edges snap to the same line keeps the grid point instead of vanishing.
      const grid = this.boardPoint(e, false);
      const end: Vec2 | null = at && grid ? [at[0] === from?.[0] ? grid[0] : at[0], at[1] === from?.[1] ? grid[1] : at[1]] : at;
      if (from && end && end[0] !== from[0] && end[1] !== from[1]) {
        const [x0, x1] = [Math.min(from[0], end[0]), Math.max(from[0], end[0])];
        const [y0, y1] = [Math.min(from[1], end[1]), Math.max(from[1], end[1])];
        this.emit({ kind, layer: this.layer, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
      } else {
        this.drawPreview();
      }
    } else if (this.kind === 'polygon' && at) {
      if (this.points.length >= 3 && this.screenDistance(this.points[0], e) < CLOSE_PX) return this.finishPolygon();
      // A corner within a few pixels of the last one is the second click of a double-click, or a wobble.
      const last = this.points.at(-1);
      if (!last || this.screenDistance(last, e) >= CLOSE_PX) this.points.push(at);
      this.drawPreview();
    } else if (this.kind === 'port' && at) {
      this.emit({ kind: 'port', layer: this.layer, at });
    }
  }

  private finishPolygon(): void {
    if (this.kind !== 'polygon') return;
    // A double-click also lands two clicks on the same corner; repeats were never added.
    if (this.points.length >= 3) this.emit({ kind: 'polygon', layer: this.layer, points: this.points });
    else this.reset();
  }

  private emit(drawn: Drawn): void {
    // A refused shape keeps its corners, so it can be fixed with Backspace.
    if (this.onDrawn(drawn)) this.reset();
  }

  private drawPreview(): void {
    for (const child of [...this.preview.children]) {
      this.preview.remove(child);
      (child as THREE.Line).geometry.dispose();
    }
    const z = (this.host.layerZ(this.layer) ?? 0) + 0.05;
    const line = (points: Vec2[], closed: boolean, dashed = false) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, y]) => new THREE.Vector3(x, y, z)));
      const material = dashed ? DASHED : SOLID;
      const object = closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
      if (dashed) object.computeLineDistances();
      object.renderOrder = 20;
      this.preview.add(object);
    };
    const c = this.cursor;
    if ((this.kind === 'rectangle' || this.kind === 'section') && this.dragFrom && c) {
      const f = this.dragFrom;
      line([[f[0], f[1]], [c[0], f[1]], [c[0], c[1]], [f[0], c[1]]], true, this.kind === 'section');
    } else if (this.kind === 'polygon' && this.points.length) {
      line(this.points, false);
      if (c) line([this.points.at(-1)!, c, ...(this.points.length >= 2 ? [this.points[0]] : [])], false, true);
    }
    if (this.active && c) {
      // A small cross at the snapped point, so the snap is visible before the click.
      const s = 0.3;
      line([[c[0] - s, c[1]], [c[0] + s, c[1]]], false);
      line([[c[0], c[1] - s], [c[0], c[1] + s]], false);
    }
    this.host.redraw();
  }
}

const PREVIEW = 0x62cde8;
const SOLID = new THREE.LineBasicMaterial({ color: PREVIEW, depthTest: false, transparent: true });
const DASHED = new THREE.LineDashedMaterial({ color: PREVIEW, dashSize: 0.4, gapSize: 0.3, depthTest: false, transparent: true });
