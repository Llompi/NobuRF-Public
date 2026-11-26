import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startCodesignBus } from '../src/design/codesign_bus';

/** Opens a page connection; the bus sends history right on connect, so messages are collected from the start. */
const open = (port: number, origin: string) => new Promise<{ ws: WebSocket; received: string[] }>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
  const received: string[] = [];
  ws.on('message', (d) => received.push(String(d)));
  ws.once('open', () => resolve({ ws, received }));
  ws.once('error', reject);
});

describe('co-design bus', () => {
  it('replays history, takes requests from a local page, and refuses other origins', async () => {
    const said: string[] = [];
    let stops = 0;
    const bus = await startCodesignBus(0, { onStopSolve: () => stops++, onSay: (t) => said.push(t), history: () => [{ type: 'run', phase: 'start' }] });
    try {
      const { ws, received } = await open(bus.port, 'http://localhost:5173');
      ws.send(JSON.stringify({ type: 'say', text: '  keep patch_w at 14 mm  ' }));
      ws.send('not json');
      ws.send(JSON.stringify({ type: 'stop_solve' }));
      ws.send(JSON.stringify({ type: 'stop' }));
      await new Promise((r) => setTimeout(r, 100));
      expect(received.map((m) => JSON.parse(m))).toEqual([{ type: 'run', phase: 'start' }]);
      expect(said).toEqual(['keep patch_w at 14 mm']);
      expect(bus.takeSays()).toEqual(['keep patch_w at 14 mm']);
      expect(bus.takeSays()).toEqual([]);
      expect(stops).toBe(1);
      expect(bus.stopRequested).toBe(true);
      ws.close();
      await expect(open(bus.port, 'https://evil.example')).rejects.toThrow();
    } finally {
      await bus.close();
    }
  });
});
