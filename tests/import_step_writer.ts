/**
 * Writes small STEP files for the STEP importer tests, laid out the way
 * OCCT-based exporters (KiCad, FreeCAD) write them: a root product whose
 * SHAPE_REPRESENTATION places each part through
 * CONTEXT_DEPENDENT_SHAPE_REPRESENTATION + ITEM_DEFINED_TRANSFORMATION, and
 * a part's B-rep in an ADVANCED_BREP_SHAPE_REPRESENTATION. Solids are
 * extruded profiles with full topology (top, bottom and side faces).
 */

type Vec2 = [number, number];
type Vec3 = [number, number, number];

/** A profile segment from `from` to the next segment's `from`: straight, or an arc around `center`. */
export type Segment = { from: Vec2 } | { from: Vec2; center: Vec2; clockwise: boolean };
/** A closed profile; a single arc segment whose end is its start is a full circle. */
export type Profile = Segment[];

export interface PartPlacement {
  /** Rotation about z in degrees, then translation. */
  rotateDeg: number;
  translate: Vec3;
}

export class StepWriter {
  private readonly lines: string[] = [];
  private nextId = 1;
  private readonly rootPlacements: number[] = [];
  private readonly lengthUnit: number;
  private readonly context: number;
  private readonly rootDefinition: number;
  private readonly rootRepresentation: number;

  /**
   * `unit` is "mm" or "inch"; `up` turns the whole model so that board up
   * is model y (as SolidWorks writes) instead of z.
   */
  constructor(private readonly options: { unit?: 'mm' | 'inch'; up?: 'z' | 'y' } = {}) {
    const mm = this.add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )');
    this.lengthUnit = options.unit === 'inch'
      ? this.add(`( CONVERSION_BASED_UNIT('INCH',${this.ref(this.add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),${this.ref(mm)})`))}) LENGTH_UNIT() NAMED_UNIT(*) )`)
      : mm;
    const radian = this.add('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )');
    this.context = this.add(
      `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((${this.ref(this.lengthUnit)},${this.ref(radian)})) ` +
      "REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )",
    );
    this.rootDefinition = this.product('demo 1');
    this.rootRepresentation = this.reserve();
    this.rootPlacements.push(this.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]));
  }

  private ref = (id: number) => `#${id}`;
  private reserve = () => this.nextId++;
  private add(text: string, id = this.reserve()): number {
    this.lines.push(`#${id} = ${text};`);
    return id;
  }
  private number = (v: number) => (Number.isInteger(v) ? `${v}.` : `${v}`);
  /** Model mm to file units, with board up turned onto y when asked. */
  private model(p: Vec3): Vec3 {
    const scale = this.options.unit === 'inch' ? 1 / 25.4 : 1;
    const [x, y, z] = p.map((v) => v * scale) as Vec3;
    return this.options.up === 'y' ? [x, z, -y] : [x, y, z];
  }
  private turn(d: Vec3): Vec3 {
    return this.options.up === 'y' ? [d[0], d[2], -d[1]] : d;
  }
  private point(p: Vec3) {
    return this.add(`CARTESIAN_POINT('',(${this.model(p).map(this.number).join(',')}))`);
  }
  private direction(d: Vec3) {
    return this.add(`DIRECTION('',(${this.turn(d).map(this.number).join(',')}))`);
  }
  private axis(origin: Vec3, z: Vec3, x: Vec3) {
    return this.add(`AXIS2_PLACEMENT_3D('',${this.ref(this.point(origin))},${this.ref(this.direction(z))},${this.ref(this.direction(x))})`);
  }
  private vertex(p: Vec3) {
    return this.add(`VERTEX_POINT('',${this.ref(this.point(p))})`);
  }
  private lineEdge(a: number, b: number, from: Vec3, to: Vec3) {
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const length = Math.hypot(...d);
    const line = this.add(`LINE('',${this.ref(this.point(from))},${this.ref(this.add(`VECTOR('',${this.ref(this.direction(d.map((v) => v / length) as Vec3))},${this.number(length)})`))})`);
    return this.add(`EDGE_CURVE('',${this.ref(a)},${this.ref(b)},${this.ref(line)},.T.)`);
  }
  private oriented(edge: number, forward: boolean) {
    return this.add(`ORIENTED_EDGE('',*,*,${this.ref(edge)},${forward ? '.T.' : '.F.'})`);
  }
  private loopBound(type: 'FACE_OUTER_BOUND' | 'FACE_BOUND', orientedEdges: number[]) {
    const loop = this.add(`EDGE_LOOP('',(${orientedEdges.map(this.ref).join(',')}))`);
    return this.add(`${type}('',${this.ref(loop)},.T.)`);
  }

  /** Edges of one profile at height z: per segment, [edge id, start vertex]. */
  private profileEdges(profile: Profile, z: number): Array<{ edge: number; vertex: number }> {
    const vertices = profile.map((s) => this.vertex([s.from[0], s.from[1], z]));
    return profile.map((segment, n) => {
      const next = (n + 1) % profile.length;
      const from: Vec3 = [segment.from[0], segment.from[1], z];
      const to: Vec3 = [profile[next].from[0], profile[next].from[1], z];
      if (!('center' in segment)) return { edge: this.lineEdge(vertices[n], vertices[next], from, to), vertex: vertices[n] };
      const radius = Math.hypot(from[0] - segment.center[0], from[1] - segment.center[1]);
      // Clockwise arcs use a circle whose axis points down, so the edge still follows the curve's sense.
      const circleAxis = this.axis([segment.center[0], segment.center[1], z], [0, 0, segment.clockwise ? -1 : 1], [1, 0, 0]);
      const circle = this.add(`CIRCLE('',${this.ref(circleAxis)},${this.number(radius)})`);
      return { edge: this.add(`EDGE_CURVE('',${this.ref(vertices[n])},${this.ref(vertices[next])},${this.ref(circle)},.T.)`), vertex: vertices[n] };
    });
  }

  /** A solid: the profiles (outer first, then holes) extruded from z0 to z1. */
  solid(profiles: Profile[], z0: number, z1: number): number {
    const bottom = profiles.map((p) => this.profileEdges(p, z0));
    const top = profiles.map((p) => this.profileEdges(p, z1));
    const faces: number[] = [];
    const horizontal = (edges: Array<Array<{ edge: number }>>, z: number, up: boolean) => {
      const plane = this.add(`PLANE('',${this.ref(this.axis([0, 0, z], [0, 0, 1], [1, 0, 0]))})`);
      const bounds = edges.map((loop, n) => this.loopBound(n === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND', loop.map((e) => this.oriented(e.edge, up))));
      faces.push(this.add(`ADVANCED_FACE('',(${bounds.map(this.ref).join(',')}),${this.ref(plane)},${up ? '.T.' : '.F.'})`));
    };
    horizontal(top, z1, true);
    horizontal(bottom, z0, false);
    profiles.forEach((profile, p) => {
      const risers = profile.map((s, n) => this.lineEdge(bottom[p][n].vertex, top[p][n].vertex, [s.from[0], s.from[1], z0], [s.from[0], s.from[1], z1]));
      profile.forEach((segment, n) => {
        const next = (n + 1) % profile.length;
        const surface = 'center' in segment
          ? this.add(`CYLINDRICAL_SURFACE('',${this.ref(this.axis([segment.center[0], segment.center[1], z0], [0, 0, 1], [1, 0, 0]))},${this.number(Math.hypot(segment.from[0] - segment.center[0], segment.from[1] - segment.center[1]))})`)
          : (() => {
            const [a, b] = [segment.from, profile[next].from];
            const along = [b[0] - a[0], b[1] - a[1]];
            const length = Math.hypot(along[0], along[1]);
            return this.add(`PLANE('',${this.ref(this.axis([a[0], a[1], z0], [along[1] / length, -along[0] / length, 0], [along[0] / length, along[1] / length, 0]))})`);
          })();
        const edges = profile.length === 1
          ? [this.oriented(bottom[p][n].edge, true), this.oriented(risers[n], true), this.oriented(top[p][n].edge, false), this.oriented(risers[n], false)]
          : [this.oriented(bottom[p][n].edge, true), this.oriented(risers[next], true), this.oriented(top[p][n].edge, false), this.oriented(risers[n], false)];
        faces.push(this.add(`ADVANCED_FACE('',(${this.ref(this.loopBound('FACE_OUTER_BOUND', edges))}),${this.ref(surface)},.T.)`));
      });
    });
    const shell = this.add(`CLOSED_SHELL('',(${faces.map(this.ref).join(',')}))`);
    return this.add(`MANIFOLD_SOLID_BREP('',${this.ref(shell)})`);
  }

  /** A zero-thickness sheet: one face of the profiles at height z. */
  sheet(profiles: Profile[], z: number): number {
    const plane = this.add(`PLANE('',${this.ref(this.axis([0, 0, z], [0, 0, 1], [1, 0, 0]))})`);
    const bounds = profiles.map((p, n) => this.loopBound(n === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND', this.profileEdges(p, z).map((e) => this.oriented(e.edge, true))));
    const face = this.add(`ADVANCED_FACE('',(${bounds.map(this.ref).join(',')}),${this.ref(plane)},.T.)`);
    const shell = this.add(`OPEN_SHELL('',(${this.ref(face)}))`);
    return this.add(`SHELL_BASED_SURFACE_MODEL('',(${this.ref(shell)}))`);
  }

  /** A cone frustum around (x, y) from z0 (radius r0) to z1 (radius r1): a body that is not flat. */
  cone(center: Vec2, r0: number, r1: number, z0: number, z1: number): number {
    const circleEdge = (r: number, z: number) => {
      const v = this.vertex([center[0] + r, center[1], z]);
      const circle = this.add(`CIRCLE('',${this.ref(this.axis([center[0], center[1], z], [0, 0, 1], [1, 0, 0]))},${this.number(r)})`);
      return this.add(`EDGE_CURVE('',${this.ref(v)},${this.ref(v)},${this.ref(circle)},.T.)`);
    };
    const halfAngle = Math.atan2(r0 - r1, z1 - z0);
    const cone = this.add(`CONICAL_SURFACE('',${this.ref(this.axis([center[0], center[1], z0], [0, 0, 1], [1, 0, 0]))},${this.number(r0)},${this.number(halfAngle)})`);
    const bounds = [this.loopBound('FACE_OUTER_BOUND', [this.oriented(circleEdge(r0, z0), true)]), this.loopBound('FACE_BOUND', [this.oriented(circleEdge(r1, z1), false)])];
    const face = this.add(`ADVANCED_FACE('',(${bounds.map(this.ref).join(',')}),${this.ref(cone)},.T.)`);
    const shell = this.add(`OPEN_SHELL('',(${this.ref(face)}))`);
    return this.add(`SHELL_BASED_SURFACE_MODEL('',(${this.ref(shell)}))`);
  }

  private product(name: string): number {
    const productContext = this.add("PRODUCT_CONTEXT('',#0,'mechanical')".replace('#0', this.ref(this.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')"))));
    const product = this.add(`PRODUCT('${name.replace(/'/g, "''")}','${name.replace(/'/g, "''")}','',(${this.ref(productContext)}))`);
    const formation = this.add(`PRODUCT_DEFINITION_FORMATION('','',${this.ref(product)})`);
    return this.add(`PRODUCT_DEFINITION('design','',${this.ref(formation)},$)`);
  }

  /**
   * A part holding `bodies`, placed once per placement. With `viaShapeRepresentation`
   * the product's SHAPE_REPRESENTATION links to the B-rep representation with a
   * plain SHAPE_REPRESENTATION_RELATIONSHIP, as OCCT writes it.
   */
  part(name: string, bodies: number[], placements: PartPlacement[], viaShapeRepresentation = false): void {
    const definition = this.product(name);
    const brepRepresentation = this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${bodies.map(this.ref).join(',')}),${this.ref(this.context)})`);
    let partRepresentation = brepRepresentation;
    if (viaShapeRepresentation) {
      partRepresentation = this.add(`SHAPE_REPRESENTATION('',(${this.ref(this.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]))}),${this.ref(this.context)})`);
      this.add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',${this.ref(brepRepresentation)},${this.ref(partRepresentation)})`);
    }
    this.add(`SHAPE_DEFINITION_REPRESENTATION(${this.ref(this.add(`PRODUCT_DEFINITION_SHAPE('','',${this.ref(definition)})`))},${this.ref(partRepresentation)})`);
    for (const { rotateDeg, translate } of placements) {
      const a = (rotateDeg * Math.PI) / 180;
      const target = this.axis(translate, [0, 0, 1], [Math.cos(a), Math.sin(a), 0]);
      this.rootPlacements.push(target);
      const transformation = this.add(`ITEM_DEFINED_TRANSFORMATION('','',${this.ref(this.rootPlacements[0])},${this.ref(target)})`);
      const relationship = this.add(
        `( REPRESENTATION_RELATIONSHIP('','',${this.ref(partRepresentation)},${this.ref(this.rootRepresentation)}) ` +
        `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${this.ref(transformation)}) SHAPE_REPRESENTATION_RELATIONSHIP() )`,
      );
      const usage = this.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('','','',${this.ref(this.rootDefinition)},${this.ref(definition)},$)`);
      this.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${this.ref(relationship)},${this.ref(this.add(`PRODUCT_DEFINITION_SHAPE('','',${this.ref(usage)})`))})`);
    }
  }

  toString(): string {
    const rootDefinitionShape = this.add(`PRODUCT_DEFINITION_SHAPE('','',${this.ref(this.rootDefinition)})`);
    this.add(`SHAPE_REPRESENTATION('',(${this.rootPlacements.map(this.ref).join(',')}),${this.ref(this.context)})`, this.rootRepresentation);
    this.add(`SHAPE_DEFINITION_REPRESENTATION(${this.ref(rootDefinitionShape)},${this.ref(this.rootRepresentation)})`);
    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('NobuRF test board'),'2;1');",
      "FILE_NAME('demo.step','2026-11-19T00:00:00',(''),(''),'','','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;',
      ...this.lines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');
  }
}

/** A rectangle profile, counter-clockwise. */
export const rectangle = (x0: number, y0: number, x1: number, y1: number): Profile => [
  { from: [x0, y0] }, { from: [x1, y0] }, { from: [x1, y1] }, { from: [x0, y1] },
];

/** A full circle profile (one arc edge from a point back to itself). */
export const circle = (cx: number, cy: number, r: number, clockwise = false): Profile => [{ from: [cx + r, cy], center: [cx, cy], clockwise }];

/**
 * The demo board, in board mm before placement:
 *   demo_PCB     40 x 30 x 1.6 mm FR-4 body with a 3 mm mounting hole at (35, 25),
 *                drawn as a clockwise circle
 *   demo_patch   20 x 15 mm top copper (z 1.6 to 1.635) at (10, 5), its top-right corner
 *                rounded with r = 2 mm, and a 2 mm hole at (20, 12.5)
 *   demo_pad     2 x 2 mm top pad, one part placed twice
 *   demo_ground  bottom copper sheet over the whole board at z = 0
 *   demo_sma     a cone (not flat) standing on the board
 * The board parts are rotated 90 degrees about z and moved to (100, -50).
 */
export function demoBoard(options: { unit?: 'mm' | 'inch'; up?: 'z' | 'y' } = {}): string {
  const w = new StepWriter(options);
  const onBoard: PartPlacement = { rotateDeg: 90, translate: [100, -50, 0] };
  w.part('demo_PCB', [w.solid([rectangle(0, 0, 40, 30), circle(35, 25, 1.5, true)], 0, 1.6)], [onBoard], true);
  const patch: Profile = [{ from: [10, 5] }, { from: [30, 5] }, { from: [30, 18], center: [28, 18], clockwise: false }, { from: [28, 20] }, { from: [10, 20] }];
  w.part('demo_patch', [w.solid([patch, circle(20, 12.5, 1)], 1.6, 1.635)], [onBoard]);
  w.part('demo_pad', [w.solid([rectangle(-1, -1, 1, 1)], 1.6, 1.635)], [
    { rotateDeg: 0, translate: [100 - 3, -50 + 2, 0] },
    { rotateDeg: 0, translate: [100 - 3, -50 + 38, 0] },
  ]);
  w.part('demo_ground', [w.sheet([rectangle(0, 0, 40, 30)], 0)], [onBoard]);
  w.part('demo_sma', [w.cone([5, 5], 2, 1, 1.6, 5)], [onBoard]);
  return w.toString();
}
