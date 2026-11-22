import { describe, expect, it } from 'vitest';
import { drillVias, parseExcellon } from '../src/import/excellon';
import { ImportError } from '../src/import/geometry';

// The shape of KiCad 10's PTH file in decimal millimetres, trimmed; the coordinates are made up.
const PTH = `M48
; DRILL file KiCad 10.0.8
; FORMAT={-:-/ absolute / metric / decimal}
; #@! TF.FileFunction,Plated,1,4,PTH
FMAT,2
METRIC
; #@! TA.AperFunction,Plated,PTH,ViaDrill
T1C0.300
; #@! TA.AperFunction,Plated,PTH,ComponentDrill
T2C0.600
%
G90
G05
T1
X3.0Y-12.0
X3.0Y-21.0
T2
X10.0Y-20.0G85X10.0Y-21.1
G05
T0
M30
`;

const header = (body: string, units = 'METRIC') => `M48\n${units}\nT1C0.3\n%\nT1\n${body}\nM30\n`;

describe('parseExcellon', () => {
  it('reads tools, hits and G85 slots in millimetres', () => {
    const file = parseExcellon(PTH, 'board-PTH.drl');
    expect(file.span).toEqual([1, 4]);
    expect(file.holes).toEqual([
      { x: 3, y: -12, drill: 0.3, plated: true },
      { x: 3, y: -21, drill: 0.3, plated: true },
      { x: 10, y: -20, drill: 0.6, plated: true, to: [10, -21.1] },
    ]);
  });

  it('scales an inch file, slots included, and follows M71 / M72', () => {
    const inch = parseExcellon('M48\nINCH\nT1C0.0118\n%\nT1\nX1.0Y-0.5G85X1.1Y-0.5\nM71\nX2.0Y1.0\nM30\n', 'board.drl');
    expect(inch.holes[0].x).toBeCloseTo(25.4, 9);
    expect(inch.holes[0].to![0]).toBeCloseTo(27.94, 9);
    expect(inch.holes[0].drill).toBeCloseTo(0.29972, 9);
    expect(inch.holes[1]).toMatchObject({ x: 2, y: 1 });
  });

  it('keeps the last X or Y when a hit gives only the other (modal coordinates)', () => {
    const file = parseExcellon(header('X1.0Y2.0\nX3.0\nY4.0'), 'modal.drl');
    expect(file.holes.map((h) => [h.x, h.y])).toEqual([[1, 2], [3, 2], [3, 4]]);
  });

  it('reads a straight routed slot (G00, M15, G01, M16)', () => {
    const file = parseExcellon(header('G00X1.0Y1.0\nM15\nG01X1.0Y2.5\nM16\nG05\nX5.0Y5.0'), 'route.drl');
    expect(file.holes).toEqual([
      { x: 1, y: 1, drill: 0.3, plated: true, to: [1, 2.5] },
      { x: 5, y: 5, drill: 0.3, plated: true },
    ]);
  });

  it('selects a tool defined in the program body, as a drill machine does', () => {
    const file = parseExcellon(header('X1.0Y1.0\nT3C2.0\nX2.0Y2.0'), 'body-tool.drl');
    expect(file.holes.map((h) => h.drill)).toEqual([0.3, 2]);
  });

  it('refuses a tool without a valid diameter, with its line', () => {
    expect(() => parseExcellon('M48\nMETRIC\nT1C-\n%\n', 'bad-tool.drl')).toThrow('line 3');
  });

  it('refuses a routed path with a corner rather than doubling the corner via', () => {
    expect(() => parseExcellon(header('G00X1.0Y1.0\nM15\nG01X1.0Y2.0\nG01X2.0Y2.0\nM16'), 'corner.drl')).toThrow('more than one straight segment');
  });

  it('numbers vias on from a given number', () => {
    const { vias } = drillVias(parseExcellon(PTH, 'board-PTH.drl'), ['bottom', 'top'], 4, 'board-PTH.drl', 171);
    expect(vias.map((v) => v.id)).toEqual(['drill-171', 'drill-172', 'drill-173']);
  });

  it('takes plating per tool from a mixed-plating file', () => {
    const mixed = `M48
; #@! TF.FileFunction,MixedPlating,1,2
METRIC
; #@! TA.AperFunction,Plated,PTH,ViaDrill
T1C0.3
; #@! TA.AperFunction,NonPlated,NPTH,ComponentDrill
T2C3.2
%
T1
X1.0Y1.0
T2
X5.0Y5.0
M30
`;
    const file = parseExcellon(mixed, 'mixed.drl');
    expect(file.holes.map((h) => h.plated)).toEqual([true, false]);
    const { vias, skipped } = drillVias(file, ['bottom', 'top'], 2, 'mixed.drl');
    expect(vias).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('knows the NPTH file and makes no vias of it', () => {
    const file = parseExcellon(PTH.replace('Plated,1,4,PTH', 'NonPlated,1,4,NPTH').replace(/TA\.AperFunction,Plated/g, 'TA.AperFunction,NonPlated'), 'board-NPTH.drl');
    expect(file.holes.every((h) => !h.plated)).toBe(true);
    expect(() => drillVias(file, ['bottom', 'top'], 4, 'board-NPTH.drl')).toThrow('no plated holes');
  });

  it('refuses blind and buried holes rather than making them through vias', () => {
    const blind = parseExcellon(PTH.replace('Plated,1,4,PTH', 'Plated,1,2,Blind'), 'blind.drl');
    expect(() => drillVias(blind, ['bottom', 'top'], 4, 'blind.drl')).toThrow('blind and buried');
  });

  it('refuses implied-decimal coordinates instead of guessing them', () => {
    expect(() => parseExcellon(header('X30000Y-120000'), 'old.drl')).toThrow(ImportError);
  });

  it('refuses a hole that uses an undefined tool', () => {
    expect(() => parseExcellon('M48\nMETRIC\nT1C0.3\n%\nT2\nX1.0Y1.0\n', 'bad.drl')).toThrow('never defined');
  });

  it('refuses commands it would otherwise skip and misplace holes by: repeats, offsets, arcs, unknowns', () => {
    expect(() => parseExcellon(header('X1.0Y1.0\nR3X2.54'), 'repeat.drl')).toThrow('line 7');
    expect(() => parseExcellon(header('G93X1.0Y1.0\nX1.0Y1.0'), 'offset.drl')).toThrow('G93');
    expect(() => parseExcellon(header('G00X1.0Y1.0\nM15\nG02X2.0Y2.0A1.0\nM16'), 'arc.drl')).toThrow('G02');
    expect(() => parseExcellon(header('ICI,ON\nX1.0Y1.0'), 'incremental.drl')).toThrow('ICI,ON');
  });
});

describe('drillVias', () => {
  it('makes through vias, and a slot a two-via fence ending on its far end', () => {
    const { vias, skipped } = drillVias(parseExcellon(PTH, 'board-PTH.drl'), ['bottom', 'top'], 4, 'board-PTH.drl');
    expect(skipped).toBe(0);
    expect(vias[0]).toEqual({ id: 'drill-1', x: '3 mm', y: '-12 mm', drill: '0.3 mm', between: ['bottom', 'top'] });
    expect(vias[2]).toMatchObject({ x: '10 mm', y: '-20 mm', to: ['10 mm', '-21.1 mm'], pitch: '1.1 mm' });
  });

  it('puts a slot no longer than its width, or barely longer, at its middle', () => {
    const at = (to: [number, number]) => drillVias({ span: null, holes: [{ x: 0, y: 0, drill: 1, plated: true, to }] }, ['gnd', 'top'], 2, 'x.drl').vias[0];
    expect(at([0.5, 0])).toEqual({ id: 'drill-1', x: '0.25 mm', y: '0 mm', drill: '1 mm', between: ['gnd', 'top'] });
    // 1.0000004 mm: the pitch rounds down to the drill, so a fence would fail "vias would touch".
    expect(at([1.0000004, 0])).not.toHaveProperty('to');
  });
});
