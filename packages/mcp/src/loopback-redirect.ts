import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { McpAuthorizationError } from './remote-errors.ts';
import type { McpTimers } from './timers.ts';

export const LOOPBACK_REDIRECT_HOST = '127.0.0.1';
export const LOOPBACK_REDIRECT_PATH = '/callback';

export type LoopbackRedirect = {
  redirectUrl: string;
  callback(options: { state: string; signal: AbortSignal; timeoutMs: number }): Promise<URLSearchParams>;
  close(): Promise<void>;
};

export type LoopbackRedirectOptions = { port: number; timers: McpTimers };

const COMPLETION_PAGE = '<!doctype html><title>MomongaCode</title><p>Authorization finished. You can close this window.</p>';

export const startLoopbackRedirect = async ({ port, timers }: LoopbackRedirectOptions): Promise<LoopbackRedirect> => {
  let expectedState: string | undefined;
  let deliver: ((params: URLSearchParams) => void) | undefined;
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const boundPort = (server.address() as AddressInfo).port;
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_REDIRECT_HOST}:${boundPort}`);
    const hostOk = req.headers.host === `${LOOPBACK_REDIRECT_HOST}:${boundPort}` || req.headers.host === `localhost:${boundPort}`;
    if (req.method !== 'GET' || url.pathname !== LOOPBACK_REDIRECT_PATH || !hostOk || deliver === undefined) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('state mismatch');
      return;
    }
    const complete = deliver;
    deliver = undefined;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(COMPLETION_PAGE, () => complete(url.searchParams));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_REDIRECT_HOST, resolve);
  });
  const boundPort = (server.address() as AddressInfo).port;
  return {
    redirectUrl: `http://${LOOPBACK_REDIRECT_HOST}:${boundPort}${LOOPBACK_REDIRECT_PATH}`,
    callback: ({ state, signal, timeoutMs }) =>
      new Promise<URLSearchParams>((resolve, reject) => {
        signal.throwIfAborted();
        expectedState = state;
        const timer = timers.setTimeout(() => {
          finish(() => reject(new McpAuthorizationError('timed_out', 'authorization was not completed in the browser in time')));
        }, timeoutMs);
        const onAbort = (): void => finish(() => reject(signal.reason));
        function finish(settle: () => void): void {
          timers.clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          deliver = undefined;
          settle();
        }
        signal.addEventListener('abort', onAbort, { once: true });
        deliver = (params) => finish(() => resolve(params));
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
      }),
  };
};
