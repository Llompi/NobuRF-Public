/** Worker thread for the design evaluator: one CPU solve per message. See evaluate.ts. */
import { parentPort } from 'node:worker_threads';
import type { Project } from '../project/schema';
import { solveForMetrics } from './evaluate';
import type { DesignGoal } from './goal';

parentPort!.on('message', async ({ id, project, goal }: { id: number; project: Project; goal: DesignGoal }) => {
  try {
    parentPort!.postMessage({ id, result: await solveForMetrics(project, goal, false) });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message });
  }
});
