import type { BridgeToClient, ClientToBridge } from './engine/types';

/** WebSocket close code the bridge uses when a newer tab takes over the solver. */
const REPLACED_BY_NEWER_TAB = 4000;

export type BridgeLinkStatus = 'connected' | 'offline' | 'replaced';

/**
 * Browser end of the bridge. Reconnects with backoff so the page survives a
 * bridge restart (tsx watch restarts it on every server edit).
 */
export function connectBridge(
  onMessage: (msg: BridgeToClient, reply: (m: ClientToBridge) => void) => void,
  onStatus: (status: BridgeLinkStatus) => void,
  hello: () => ClientToBridge,
): void {
  let delay = 500;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/sim-client`);
    const reply = (m: ClientToBridge) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
    ws.onopen = () => {
      delay = 500;
      onStatus('connected');
      reply(hello());
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(String(ev.data)) as BridgeToClient, reply);
      } catch (e) {
        console.error('[bridge] bad message', e);
      }
    };
    ws.onclose = (ev) => {
      if (ev.code === REPLACED_BY_NEWER_TAB) {
        onStatus('replaced'); // the bridge is fine; it now sends solves to the newer tab
        return;
      }
      onStatus('offline');
      setTimeout(open, delay);
      delay = Math.min(8000, delay * 2);
    };
  };
  open();
}
