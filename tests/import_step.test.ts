import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boundingBox, ImportError } from '../src/import/geometry';
import { flatBody, parseStep, selectStepBodies, stepCopper, stepOutline } from '../src/import/step';
import { parseStepFile, StepEnum, StepRef, StepTyped } from '../src/import/step_file';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { area, expectBox, expectChordedArea, FIXTURES, paintedArea } from './import_helpers';
import { demoBoard, rectangle, StepWriter } from './import_step_writer';

const TOP = '@1.6mm..1.635mm';

describe('STEP Part 21 reader', () => {
  it('reads simple and complex instances, strings, enums, typed values and comments', () => {
    const text = [
      'ISO-10303-21;',
      "HEADER; FILE_NAME('a;b.step','',(''),(''),'','',''); ENDSEC;",
      'DATA;',
      "#1 = PRODUCT('it''s; fine','x','',(#2)); /* a comment; with a semicolon */",
      '#2 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
      "#3 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#2,'d',\n  'e');",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');
    const instances = parseStepFile(text, 't.step');
    expect(instances.get(1)!.records[0].args).toEqual(["it's; fine", 'x', '', [new StepRef(2)]]);
    expect(instances.get(2)!.records.map((r) => r.type)).toEqual(['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
    expect(instances.get(2)!.records[2].args).toEqual([new StepEnum('MILLI'), new StepEnum('METRE')]);
    expect(instances.get(3)!.records[0].args[0]).toEqual(new StepTyped('LENGTH_MEASURE', [1e-7]));
    expect(instances.get(3)!.line).toBe(6);
  });

  it('fails naming the line', () => {
    const text = 'ISO-10303-21;\nDATA;\n#1 = PRODUCT(\'a\',);\nENDSEC;\n';
    expect(() => parseStepFile(text, 'bad.step')).toThrow(/^bad\.step:3: /);
    expect(() => parseStepFile('PK\u0003\u0004', 'zip.step')).toThrow('not a STEP file');
    expect(() => parseStepFile('ISO-10303-21;\nDATA;\n#1 = A(1);\n#1 = A(2);\nENDSEC;', 'd.step')).toThrow('d.step:4: #1 is defined twice');
    // ".5" is a number, never an enumeration.
    expect(parseStepFile('ISO-10303-21;\nDATA;\n#1 = A(.5);\nENDSEC;', 'e.step').get(1)!.records[0].args).toEqual([0.5]);
  });

  it('refuses a file cut short, and reads named edition-3 DATA sections', () => {
    const whole = demoBoard();
    expect(() => parseStepFile(whole.slice(0, whole.length / 2), 'cut.step')).toThrow(/cut short/);
    expect(() => parseStepFile(whole.slice(0, whole.indexOf('ENDSEC;', whole.indexOf('DATA;'))), 'cut.step')).toThrow('the DATA section never ends');
    const named = whole.replace('DATA;', "DATA('main',('AUTOMOTIVE_DESIGN'));");
    expect(parseStepFile(named, 'named.step').size).toBe(parseStepFile(whole, 'whole.step').size);
  });
});

describe('STEP bodies', () => {
  const model = parseStep(demoBoard(), 'demo.step');

  it('finds every placed body, naming it after its product', () => {
    expect(model.bodies.map((b) => b.name)).toEqual(['demo_PCB', 'demo_patch', 'demo_pad', 'demo_pad', 'demo_ground', 'demo_sma']);
  });

  it('places parts through the assembly (rotated 90 degrees, moved to (100, -50))', () => {
    const board = flatBody(model, model.bodies[0]);
    expect([board.zMin, board.zMax]).toEqual([0, 1.6]);
    expectBox(board.shapes.filter((s) => s.op === 'add').map((s) => s.polygon), [70, -50, 100, -10]);
    // The mounting hole (drawn clockwise) at board (35, 25) lands at (100 - 25, -50 + 35).
    const hole = board.shapes.find((s) => s.op === 'cut')!;
    expectBox([hole.polygon], [73.5, -16.5, 76.5, -13.5]);
    expectChordedArea(area(hole.polygon), Math.PI * 1.5 ** 2, 2 * Math.PI * 1.5);
  });

  it('takes the top face of a solid, with a rounded corner and a hole', () => {
    const patch = flatBody(model, model.bodies[1]);
    expect([patch.zMin, patch.zMax]).toEqual([1.6, 1.635]);
    expect(patch.shapes.map((s) => s.op)).toEqual(['add', 'cut']);
    expectChordedArea(area(patch.shapes[0].polygon), 300 - (4 - Math.PI), Math.PI);
    expectBox([patch.shapes[0].polygon], [80, -40, 95, -20]);
  });

  it('takes the face of a sheet body', () => {
    const ground = flatBody(model, model.bodies[4]);
    expect([ground.zMin, ground.zMax]).toEqual([0, 0]);
    expect(area(ground.shapes[0].polygon)).toBeCloseTo(1200, 9);
  });

  it('refuses a body that is not flat, and says how to turn the board', () => {
    expect(() => flatBody(model, model.bodies[5])).toThrow(/body "demo_sma" \(#\d+\) is not a flat body extruded along z: face #\d+ is a CONICAL_SURFACE.*--step-up/);
  });

  it('reads inch files and boards modelled with y up', () => {
    for (const [options, up] of [[{ unit: 'inch' }, 'z'], [{ up: 'y' }, 'y']] as const) {
      const other = parseStep(demoBoard(options), 'other.step', up);
      const patch = flatBody(other, other.bodies[1]);
      expect(patch.zMin).toBeCloseTo(1.6, 9);
      expectBox([patch.shapes[0].polygon], [80, -40, 95, -20]);
    }
    // Read with the wrong up axis, the y-up board's copper is not flat.
    const sideways = parseStep(demoBoard({ up: 'y' }), 'y.step');
    expect(() => flatBody(sideways, sideways.bodies[1])).toThrow('give --step-up z, y, x, -z, -y, -x');
  });

  it('refuses mixed length units', () => {
    const text = demoBoard().replace("DATA;\n", "DATA;\n#900000 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#900001)) REPRESENTATION_CONTEXT('','') );\n#900001 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );\n");
    expect(() => parseStep(text, 'mixed.step')).toThrow(/the file mixes length units \((1000 mm, 1 mm|1 mm, 1000 mm)\)/);
  });

  it('refuses edges that are not lines or circles', () => {
    const text = demoBoard().replace(/CIRCLE\('',(#\d+),1\.\)/g, "ELLIPSE('',$1,1.,0.5)");
    const other = parseStep(text, 'ellipse.step');
    expect(() => flatBody(other, other.bodies[1])).toThrow(/is a ELLIPSE; flat faces may use lines and circular arcs only/);
  });
});

describe('STEP placements and faces', () => {
  it('places a representation used through MAPPED_ITEM', () => {
    // A root representation that holds the patch's representation twice, as MAPPED_ITEMs 100 mm apart.
    const board = demoBoard();
    const patchRepresentation = /#(\d+) = ADVANCED_BREP_SHAPE_REPRESENTATION\('',\((#\d+)\)/g;
    const ids = [...board.matchAll(patchRepresentation)].map((m) => m[1]);
    const context = /GEOMETRIC_REPRESENTATION_CONTEXT/.exec(board) && /#(\d+) = \( GEOMETRIC_REPRESENTATION_CONTEXT/.exec(board)![1];
    const extra = [
      "#900001 = CARTESIAN_POINT('',(0.,0.,0.));",
      "#900002 = AXIS2_PLACEMENT_3D('',#900001,$,$);",
      "#900003 = CARTESIAN_POINT('',(100.,0.,0.));",
      "#900004 = AXIS2_PLACEMENT_3D('',#900003,$,$);",
      `#900005 = REPRESENTATION_MAP(#900002,#${ids[1]});`,
      "#900006 = MAPPED_ITEM('',#900005,#900002);",
      "#900007 = MAPPED_ITEM('',#900005,#900004);",
      `#900008 = SHAPE_REPRESENTATION('',(#900006,#900007),#${context});`,
    ].join('\n');
    const model = parseStep(board.replace('ENDSEC;\nEND-ISO', `${extra}\nENDSEC;\nEND-ISO`), 'mapped.step');
    const patches = model.bodies.filter((b) => b.name === 'demo_patch').map((b) => boundingBox(flatBody(model, b).shapes.map((s) => s.polygon)).minX);
    // Once through the assembly (rotated, at x 80), and twice through the map (unrotated, at x 10 and 110).
    expect(patches.sort((a, b) => a - b).map((x) => Math.round(x * 1e6) / 1e6)).toEqual([10, 80, 110]);
  });

  /** The demo board with `lines` (STEP records using #9xxxxx ids, `ctx` for the context, `patch` for the patch representation) appended. */
  const withRecords = (lines: (ids: { ctx: string; patch: string }) => string[]) => {
    const board = demoBoard();
    const patch = /#(\d+) = ADVANCED_BREP_SHAPE_REPRESENTATION\('',\((#\d+)\)/.exec(board)![1];
    const ctx = /#(\d+) = \( GEOMETRIC_REPRESENTATION_CONTEXT/.exec(board)![1];
    return board.replace('ENDSEC;\nEND-ISO', `${lines({ ctx, patch }).join('\n')}\nENDSEC;\nEND-ISO`);
  };

  it('refuses an assembly that contains itself', () => {
    // A representation holding the patch and, through a map, itself.
    const text = withRecords(({ ctx, patch }) => [
      "#900001 = CARTESIAN_POINT('',(0.,0.,0.));",
      "#900002 = AXIS2_PLACEMENT_3D('',#900001,$,$);",
      '#900003 = REPRESENTATION_MAP(#900002,#900005);',
      "#900004 = MAPPED_ITEM('',#900003,#900002);",
      `#900005 = SHAPE_REPRESENTATION('',(#900004,#900007),#${ctx});`,
      `#900006 = REPRESENTATION_MAP(#900002,#${patch});`,
      "#900007 = MAPPED_ITEM('',#900006,#900002);",
    ]);
    expect(() => parseStep(text, 'cycle.step')).toThrow(/contains itself/);
  });

  it('refuses an assembly that would place parts too many times, without walking every path', () => {
    // 40 levels, each holding the level below twice: 2^40 placements of the patch.
    const text = withRecords(({ ctx, patch }) => {
      const out = ["#900001 = CARTESIAN_POINT('',(0.,0.,0.));", "#900002 = AXIS2_PLACEMENT_3D('',#900001,$,$);"];
      let below = patch;
      for (let level = 0; level < 40; level++) {
        const id = 900010 + 10 * level;
        out.push(`#${id} = REPRESENTATION_MAP(#900002,#${below});`, `#${id + 1} = MAPPED_ITEM('',#${id},#900002);`,
          `#${id + 2} = MAPPED_ITEM('',#${id},#900002);`, `#${id + 3} = SHAPE_REPRESENTATION('',(#${id + 1},#${id + 2}),#${ctx});`);
        below = String(id + 3);
      }
      return out;
    });
    const t0 = performance.now();
    expect(() => parseStep(text, 'diamond.step')).toThrow(/more than 100000 times/);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('follows the sense of edges and of POLY_LOOP bounds', () => {
    // Reversing every arc edge (swap its vertices, flip same_sense) must not change the copper.
    const board = demoBoard();
    const flipped = board.replace(/EDGE_CURVE\('',(#\d+),(#\d+),(#\d+),\.T\.\)/g, (all, a, b, curve) => {
      const isCircle = new RegExp(`${curve} = CIRCLE`).test(board);
      return isCircle ? `EDGE_CURVE('',${b},${a},${curve},.F.)` : all;
    });
    const patchArea = (text: string) => {
      const model = parseStep(text, 'p.step');
      return area(flatBody(model, model.bodies[1]).shapes[0].polygon);
    };
    expect(patchArea(flipped)).toBeCloseTo(patchArea(board), 9);

    // A faceted square listed clockwise with its bound flagged .F. faces up.
    const w = new StepWriter();
    const square = [[0, 0], [0, 2], [2, 2], [2, 0]].map(([x, y]) => `CARTESIAN_POINT('',(${x}.,${y}.,1.))`);
    const text = w.toString().replace('ENDSEC;\nEND-ISO', [
      ...square.map((p, n) => `#${900001 + n} = ${p};`),
      "#900010 = POLY_LOOP('',(#900001,#900002,#900003,#900004));",
      "#900011 = FACE_OUTER_BOUND('',#900010,.F.);",
      "#900012 = FACE('',(#900011));",
      "#900013 = OPEN_SHELL('',(#900012));",
      "#900014 = SHELL_BASED_SURFACE_MODEL('',(#900013));",
      `#900015 = MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#900014),${/#\d+(?= = \( GEOMETRIC)/.exec(w.toString())![0]});`,
      'ENDSEC;\nEND-ISO',
    ].join('\n'));
    const model = parseStep(text, 'faceted.step');
    const sheet = flatBody(model, model.bodies[0]);
    expect([sheet.zMin, area(sheet.shapes[0].polygon)]).toEqual([1, 4]);
  });
});

describe('choosing STEP bodies', () => {
  const model = parseStep(demoBoard(), 'demo.step');
  const names = (selector: string) => selectStepBodies(model, selector).map((b) => b.name);

  it('by name globs, case-insensitive, and by height band', () => {
    expect(names('demo_P*')).toEqual(['demo_PCB', 'demo_patch', 'demo_pad', 'demo_pad']);
    expect(names('*pcb,*GROUND')).toEqual(['demo_PCB', 'demo_ground']);
    expect(names(TOP)).toEqual(['demo_patch', 'demo_pad', 'demo_pad']);
    expect(names('*pad*@1.6mm..1.635mm')).toEqual(['demo_pad', 'demo_pad']);
    expect(names('@0mm..0mm')).toEqual(['demo_ground']);
    expect(names('@-1mm..2mm')).toEqual(['demo_PCB', 'demo_patch', 'demo_pad', 'demo_pad', 'demo_ground']);
  });

  it('lists the bodies by height when nothing matches', () => {
    let message = '';
    try {
      names('nothing');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('demo.step: no body matches "nothing". Bodies in the file (z up is model z):');
    expect(message).toContain('z 1.6 to 1.635 mm, 3 bodies (demo_patch, demo_pad, demo_pad): select with @1.6mm..1.635mm');
    expect(message).toContain('z 0 to 0 mm, 1 body (demo_ground): select with @0mm..0mm');
    // The board's band also holds the ground sheet, so no band selector is offered for it.
    expect(message).toMatch(/z 0 to 1\.6 mm, 1 body \(demo_PCB\)\n/);
  });

  it('refuses a band without units', () => {
    expect(() => names('@0..1')).toThrow('height "0" has no unit');
    expect(() => names('@1mm')).toThrow('expected a height band such as @0.5mm..0.535mm');
  });

  it('paints the union of bodies on a layer: bodies with holes first', () => {
    const { shapes, bodies } = stepCopper(model, TOP);
    expect(bodies.map((b) => b.name)).toEqual(['demo_patch', 'demo_pad', 'demo_pad']);
    expect(shapes.map((s) => s.op)).toEqual(['add', 'cut', 'add', 'add']);
    const painted = paintedArea(shapes, [70, -50, 100, -10], 0.05);
    expect(painted).toBeCloseTo(296 + 8, 0);
  });

  it('takes the outline from one body and counts the holes left out', () => {
    const { outline, holesLeftOut } = stepOutline(model, '*_PCB');
    expect(boundingBox([outline])).toEqual({ minX: 70, minY: -50, maxX: 100, maxY: -10 });
    expect(holesLeftOut).toBe(1);
    expect(() => stepOutline(model, TOP)).toThrow('the outline must be one body, but 3 match (demo_patch, demo_pad)');
  });

  it('places a part used twice at both places', () => {
    const pads = stepCopper(model, '*pad*').shapes.map((s) => boundingBox([s.polygon]));
    expect(pads).toEqual([{ minX: 96, minY: -49, maxX: 98, maxY: -47 }, { minX: 96, minY: -13, maxX: 98, maxY: -11 }]);
  });

  it('errors are ImportErrors', () => {
    expect(() => selectStepBodies(model, 'none')).toThrow(ImportError);
  });
});

describe('noburf import from STEP (end to end)', () => {
  it('imports top copper, a ground sheet and the outline into a project that meshes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-step-'));
    const stepPath = join(dir, 'demo.step');
    writeFileSync(stepPath, demoBoard());
    const template = JSON.parse(readFileSync(join(FIXTURES, 'template.json'), 'utf8'));
    template.ports[0].x = '12 mm'; // on the patch once the outline's corner is the origin
    template.ports[0].y = '15 mm';
    const templatePath = join(dir, 'template.json');
    writeFileSync(templatePath, JSON.stringify(template));
    const outPath = join(dir, 'board.json');
    const run = spawnSync('npx', [
      'tsx', 'scripts/noburf.ts', 'import',
      '--stackup', templatePath,
      '--layer', `top=${stepPath}:${TOP}`,
      '--layer', `gnd=${stepPath}:*ground`,
      '--outline', `${stepPath}:*_PCB`,
      '--origin', 'outline-min',
      '--out', outPath,
    ], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('top 4 shapes, gnd 1 shapes, outline 4 points');
    expect(run.stdout).toContain('top from 3 STEP bodies at z 1.6 to 1.635 mm');
    expect(run.stdout).toContain('board "demo_PCB" z 0 to 1.6 mm, 1 hole in it left out (the outline has no cut-outs)');
    // The template has 1 mm of dielectric; the STEP board is 1.6 mm thick.
    expect(run.stdout).toContain('warning: in the STEP file "top" is 1.6 mm above "gnd", but the stackup puts 1 mm of dielectric between them');
    expect(run.stdout).toContain('file point (70, -50) mm is now (0, 0)');

    const project = parseProject(JSON.parse(readFileSync(outPath, 'utf8')));
    expect(project.board.outline).toHaveLength(4);
    expect(project.board.outline).toEqual(expect.arrayContaining([['0 mm', '0 mm'], ['30 mm', '0 mm'], ['30 mm', '40 mm'], ['0 mm', '40 mm']]));
    const { model, warnings } = rasterise(project);
    expect(warnings).toEqual([]);
    expect(model.topCopper.some((c) => c === 1)).toBe(true);
  });

  it('asks for a body selector', () => {
    const run = spawnSync('npx', ['tsx', 'scripts/noburf.ts', 'import', '--stackup', 'x.json', '--layer', 'top=board.step', '--out', 'y.json'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('board.step: name the bodies to import, e.g. board.step:*_PCB or board.step:@0.5mm..0.535mm');
  });
});

describe('StepWriter sanity', () => {
  it('writes a rectangle solid whose top face is the rectangle', () => {
    const w = new StepWriter();
    w.part('box', [w.solid([rectangle(0, 0, 3, 2)], 0, 1)], [{ rotateDeg: 0, translate: [0, 0, 0] }]);
    const model = parseStep(w.toString(), 'box.step');
    expect(area(flatBody(model, model.bodies[0]).shapes[0].polygon)).toBeCloseTo(6, 12);
  });
});
