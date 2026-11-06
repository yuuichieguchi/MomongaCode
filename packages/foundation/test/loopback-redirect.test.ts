import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { OAuthAuthorizationError, startLoopbackRedirect } from '@momonga/foundation';

const WAIT_MS = 5000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const onCleanup = (cleanup: () => Promise<void> | void): void => {
  cleanups.push(cleanup);
};

type ObservedTimers = FakeTimers & { nextScheduled(match?: (ms: number) => boolean): Promise<void> };

const observedTimers = (clock: ReturnType<typeof createFakeClock>): ObservedTimers => {
  const fake = createFakeTimers(clock);
  const waiters: Array<{ match: (ms: number) => boolean; resolve: () => void }> = [];
  return {
    ...fake,
    setTimeout: (callback, ms) => {
      const handle = fake.setTimeout(callback, ms);
      for (const waiter of waiters.filter((entry) => entry.match(ms))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      return handle;
    },
    nextScheduled: (match = () => true) => new Promise<void>((resolve) => waiters.push({ match, resolve })),
  };
};

const start = async () => {
  const timers = observedTimers(createFakeClock(1_000_000));
  const redirect = await startLoopbackRedirect({ port: 0, timers });
  onCleanup(() => redirect.close());
  const url = new URL(redirect.redirectUrl);
  return { redirect, timers, url };
};

const rawGet = (port: number, pathAndQuery: string, host: string, method = 'GET'): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode as number));
    });
    req.on('error', reject);
    req.end();
  });

describe('loopback redirect listener', () => {
  it('binds the IPv4 loopback address only', async () => {
    const { redirect } = await start();
    const { port, hostname } = new URL(redirect.redirectUrl);
    expect(hostname).toBe('127.0.0.1');
    const viaIpv6 = new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '::1', port: Number(port), path: '/callback' }, (res) => resolve(res.statusCode as number));
      req.on('error', reject);
      req.end();
    });
    await expect(viaIpv6).rejects.toThrow();
  });

  it('delivers the first callback that carries the expected state and then stops listening for more', async () => {
    const { redirect, url } = await start();
    const arrived = redirect.callback({ state: 'right', signal: new AbortController().signal, timeoutMs: WAIT_MS });
    expect(await rawGet(Number(url.port), '/callback?state=wrong&code=evil', `127.0.0.1:${url.port}`)).toBe(400);
    expect(await rawGet(Number(url.port), '/other?state=right&code=x', `127.0.0.1:${url.port}`)).toBe(404);
    expect(await rawGet(Number(url.port), '/callback?state=right&code=x', `127.0.0.1:${url.port}`, 'POST')).toBe(404);
    expect(await rawGet(Number(url.port), '/callback?state=right&code=x', 'attacker.example')).toBe(404);
    expect(await rawGet(Number(url.port), '/callback?state=right&code=good&iss=i', `127.0.0.1:${url.port}`)).toBe(200);
    const params = await arrived;
    expect(params.get('code')).toBe('good');
    expect(params.get('iss')).toBe('i');
    expect(await rawGet(Number(url.port), '/callback?state=right&code=second', `127.0.0.1:${url.port}`)).toBe(404);
  });

  it('answers 404 before a callback is awaited', async () => {
    const { url } = await start();
    expect(await rawGet(Number(url.port), '/callback?state=any&code=x', `127.0.0.1:${url.port}`)).toBe(404);
  });

  it('rejects with timed_out when the wait elapses', async () => {
    const { redirect, timers } = await start();
    const armed = timers.nextScheduled((ms) => ms === WAIT_MS);
    const outcome = redirect.callback({ state: 's', signal: new AbortController().signal, timeoutMs: WAIT_MS }).then(
      () => undefined,
      (error: unknown) => error as OAuthAuthorizationError,
    );
    await armed;
    timers.advance(WAIT_MS);
    expect((await outcome)?.failure).toBe('timed_out');
  });

  it('refuses to bind a port that is taken', async () => {
    const { url } = await start();
    await expect(startLoopbackRedirect({ port: Number(url.port), timers: observedTimers(createFakeClock(0)) })).rejects.toThrow(/EADDRINUSE/);
  });
});
