import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { startLoopbackRedirect } from '@momonga/foundation';

const WAIT_MS = 5000;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const listen = async (path: string) => {
  const redirect = await startLoopbackRedirect({ port: 0, path, timers: createFakeTimers(createFakeClock(0)) });
  cleanups.push(() => redirect.close());
  return { redirect, port: Number(new URL(redirect.redirectUrl).port) };
};

const get = (port: number, pathAndQuery: string, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method: 'GET', headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode as number));
    });
    req.on('error', reject);
    req.end();
  });

describe('loopback redirect listener with the callback path as a parameter', () => {
  it('serves the path it was given and builds the redirect URL from it', async () => {
    const { redirect, port } = await listen('/auth/callback');
    expect(redirect.redirectUrl).toBe(`http://127.0.0.1:${port}/auth/callback`);
    const arrived = redirect.callback({ state: 's1', signal: new AbortController().signal, timeoutMs: WAIT_MS });
    expect(await get(port, '/callback?state=s1&code=c', `127.0.0.1:${port}`)).toBe(404);
    expect(await get(port, '/auth/callback?state=s1&code=c', `127.0.0.1:${port}`)).toBe(200);
    expect((await arrived).get('code')).toBe('c');
  });

  it('serves /callback for the MCP caller that passes it, with the same exact-host rule', async () => {
    const { redirect, port } = await listen('/callback');
    expect(redirect.redirectUrl).toBe(`http://127.0.0.1:${port}/callback`);
    const arrived = redirect.callback({ state: 's2', signal: new AbortController().signal, timeoutMs: WAIT_MS });
    expect(await get(port, '/auth/callback?state=s2&code=c', `127.0.0.1:${port}`)).toBe(404);
    expect(await get(port, '/callback?state=s2&code=via-localhost', `localhost:${port}`)).toBe(404);
    expect(await get(port, '/callback?state=s2&code=m', `127.0.0.1:${port}`)).toBe(200);
    expect((await arrived).get('code')).toBe('m');
  });

  it('accepts only the host 127.0.0.1:<port>; localhost:<port> is refused and does not consume the slot', async () => {
    const { redirect, port } = await listen('/auth/callback');
    const arrived = redirect.callback({ state: 's3', signal: new AbortController().signal, timeoutMs: WAIT_MS });
    expect(await get(port, '/auth/callback?state=s3&code=via-localhost', `localhost:${port}`)).toBe(404);
    expect(await get(port, '/auth/callback?state=s3&code=wrong-port', `127.0.0.1:${port + 1}`)).toBe(404);
    expect(await get(port, '/auth/callback?state=s3&code=right', `127.0.0.1:${port}`)).toBe(200);
    expect((await arrived).get('code')).toBe('right');
  });

  it('answers 400 to a wrong state without consuming the slot, then delivers the first valid callback once', async () => {
    const { redirect, port } = await listen('/auth/callback');
    const arrived = redirect.callback({ state: 'good', signal: new AbortController().signal, timeoutMs: WAIT_MS });
    expect(await get(port, '/auth/callback?state=bad&code=x', `127.0.0.1:${port}`)).toBe(400);
    expect(await get(port, '/auth/callback?state=good&code=first', `127.0.0.1:${port}`)).toBe(200);
    expect(await get(port, '/auth/callback?state=good&code=second', `127.0.0.1:${port}`)).toBe(404);
    expect((await arrived).get('code')).toBe('first');
  });
});
