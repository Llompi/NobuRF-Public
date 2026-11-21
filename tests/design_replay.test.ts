import { describe, expect, it } from 'vitest';
import { describeCall, replayFromJournal, servedBy, taskText } from '../src/design/replay';

const goal = { target_ghz: 5.8, s11_max_db: -10, f_tolerance_pct: 1 };
const solve = (t_ms: number, s11: number, score: number, fidelity: 'search' | 'confirm' = 'search') => ({
  t_ms, type: 'solve' as const, record: { fidelity, score, metrics: { s11_at_target_db: s11, f0_ghz: 5.8 } },
});
const model = (t_ms: number, calls: Array<[string, object]>, tokens = 120) => ({
  t_ms, type: 'model' as const, stats: { ms: 300, completion_tokens: tokens }, text: null,
  tool_calls: calls.map(([name, args]) => ({ name, arguments: JSON.stringify(args) })),
});

describe('race replay from a design journal', () => {
  it('plays the best design so far, the model turns and the calls, and ends on the confirmed design', () => {
    const journal = [
      model(400, [['optimise', { enable: ['inset'], free: ['patch_l', 'inset_d'], max_solves: 12, aim_ghz: 5.75 }]]),
      solve(1000, -4, 5),
      solve(1000, -3, 7), // a worse probe: the trace does not follow it
      solve(1600, -12, 0),
      { t_ms: 1700, type: 'tool' as const, name: 'optimise' },
      model(2000, [['confirm', {}]], 40),
      solve(2600, -11.04, 0, 'confirm'),
      { t_ms: 2700, type: 'tool' as const, name: 'confirm' },
    ];
    const log = replayFromJournal(journal, { laneLabel: 'Kimi K3.1 Pro on Cerebras', goal, modelS: 0.6, costUsd: 0.01 });
    expect(log.events.map((e) => [e.type, e.time_ms, e.s11_db_at_target ?? e.edit ?? e.output_tokens])).toEqual([
      ['start', 0, -4],
      ['model_turn_done', 400, 120],
      ['edit', 400, 'optimise patch_l, inset_d with inset, aiming at 5.75 GHz'],
      ['solve_done', 1000, -4],
      ['solve_done', 1600, -12],
      ['solve_done', 1700, -12],
      ['model_turn_done', 2000, 40],
      ['edit', 2000, 'confirm on the fine mesh'],
      ['solve_done', 2600, -11],
      ['solve_done', 2700, -11],
      ['done', 2700, -11],
    ]);
    expect(log.events.filter((e) => e.type === 'solve_done').map((e) => e.goal_met)).toEqual([false, false, false, true, true]); // met only once confirmed
    expect(log).toMatchObject({ match_threshold_db: -10, target_ghz: 5.8, result: { met: true, mesh: 'confirm', s11_db_at_target: -11 } });
  });

  it('ends on the best search design when nothing was confirmed, and refuses an empty journal', () => {
    const log = replayFromJournal([solve(500, -6, 3), model(900, [['finish', { summary: 'x' }]])], { laneLabel: 'x', goal, modelS: 0, costUsd: 0 });
    expect(log.result).toEqual({ met: false, f0_ghz: 5.8, s11_db_at_target: -6, mesh: 'search' });
    expect(() => replayFromJournal([model(1, [])], { laneLabel: 'x', goal, modelS: 0, costUsd: 0 })).toThrow(/no solved design/);
  });

  it('describes calls as a viewer reads them', () => {
    expect(describeCall('sweep', '{"variable":"slot_l","from_mm":2,"to_mm":8.456}')).toBe('sweep slot_l from 2 mm to 8.46 mm');
    expect(describeCall('try_design', '{"values":{"patch_l":11.2},"enable":["inset","slot"]}')).toBe('try patch_l = 11.2 mm with inset + slot');
    expect(describeCall('optimise', '{not json')).toBe('optimise (unreadable arguments)');
  });

  it('keeps rate-limit waits out of tokens per second, and never puts a turn after done', () => {
    const waited = { ...model(40_000, [['optimise', { free: ['patch_l'] }]]), stats: { ms: 500, completion_tokens: 100, retry_wait_ms: 30_000, served_by: 'Nebius' } };
    const journal = [solve(1000, -5, 4), { t_ms: 1000, type: 'tool' as const, name: 'try_design' }, waited, model(40_000, [['finish', {}]])];
    const log = replayFromJournal(journal, { laneLabel: 'x', goal, modelS: 1, costUsd: 0 });
    const turn = log.events.findIndex((e) => e.type === 'model_turn_done');
    expect(log.events[turn].time_ms - log.events[turn - 1].time_ms).toBe(500); // the answered attempt, not the 30 s wait
    expect(log.rate_limit_wait_s).toBe(30);
    expect(Math.max(...log.events.map((e) => e.time_ms))).toBe(log.events[log.events.length - 1].time_ms);
    expect(log.events[log.events.length - 1].type).toBe('done');
    expect(servedBy(journal)).toEqual(['Nebius']);
  });

  it('names every part of the goal in the task line', () => {
    expect(taskText(goal)).toBe('design a 5.8 GHz patch antenna, S11 at or below -10 dB with the dip within 1 %');
    expect(taskText({ ...goal, min_bandwidth_mhz: 300, max_axial_ratio_db: 3 })).toBe(
      'design a 5.8 GHz patch antenna, S11 at or below -10 dB with the dip within 1 %, at least 300 MHz of bandwidth and axial ratio at most 3 dB');
  });
});
