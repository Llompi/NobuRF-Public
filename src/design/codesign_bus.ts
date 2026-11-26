import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { isLocalHost, isLocalOrigin } from '../../server/bridge';

/**
 * The co-design run's event stream, for the live view: every journal event
 * goes out to each connected page as one JSON message, and the page sends
 * back what the person does. Local only, like the bridge: 127.0.0.1, and a
 * browser page must be served from localhost.
 *
 * In:  { type: 'say', text }   a request for the model, shown on its next call
 *      { type: 'stop_solve' }  end the running solve now
 *      { type: 'stop' }        end the run after the current step
 */
export interface CodesignBus {
  port: number;
  broadcast(event: object): void;
  /** Requests typed since the last call, oldest first. */
  takeSays(): string[];
  readonly stopRequested: boolean;
  close(): Promise<void>;
}

const MAX_SAY_CHARS = 500;

export interface CodesignBusHandlers {
  onStopSolve(): void;
  /** A request from the page, as received (before the model reads it): for the journal and every open page. */
  onSay(text: string): void;
  /** Everything so far, sent first to a page that opens mid-run. */
  history(): object[];
}

export async function startCodesignBus(port: number, handlers: CodesignBusHandlers): Promise<CodesignBus> {
  const says: string[] = [];
  let stopRequested = false;
  const http = createServer((_req, res) => res.writeHead(426, { 'content-type': 'text/plain' }).end('connect with a WebSocket'));
  const wss = new WebSocketServer({
    server: http,
    verifyClient: ({ origin, req }: { origin: string | undefined; req: { headers: { host?: string } } }) => isLocalOrigin(origin) && isLocalHost(req.headers.host),
  });
  const clients = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    // A page that opens mid-run gets everything so far first.
    for (const e of handlers.history()) ws.send(JSON.stringify(e));
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      let msg: { type?: unknown; text?: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return; // not JSON: ignored, the page is ours
      }
      if (msg.type === 'say' && typeof msg.text === 'string' && msg.text.trim()) {
        const text = msg.text.trim().slice(0, MAX_SAY_CHARS);
        says.push(text);
        handlers.onSay(text);
      } else if (msg.type === 'stop_solve') handlers.onStopSolve();
      else if (msg.type === 'stop') stopRequested = true;
    });
  });
  // ws re-emits the server's errors; the listen promise below reports them, so they must not crash the process.
  wss.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    http.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is already in use; pick another with --serve <port>`) : e));
    http.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    port: (http.address() as { port: number }).port,
    broadcast: (event) => {
      const text = JSON.stringify(event);
      for (const ws of clients) ws.send(text);
    },
    takeSays: () => says.splice(0),
    get stopRequested() {
      return stopRequested;
    },
    close: () => new Promise<void>((resolve) => {
      for (const ws of clients) ws.close();
      wss.close();
      http.close(() => resolve());
    }),
  };
}
