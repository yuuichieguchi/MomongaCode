import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { expectError, startService, waitUntil } from './helpers.ts';

const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_BUSY = 5;
const SWEEP_INTERVAL_MS = 600_000;
const POLL_INTERVAL_MS = 1000;

const sqliteError = (errcode: number, errstr: string): Error => Object.assign(new Error(errstr), { code: 'ERR_SQLITE_ERROR', errcode, errstr });

type Faults = Map<string, unknown>;

const faultyStore = (faults: Faults) => (store: RuntimeStore): RuntimeStore =>
  new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (faults.has(property)) throw faults.get(property);
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });

const captureServer = (): { server(): http.Server } => {
  const created: http.Server[] = [];
  const original = http.createServer;
  vi.spyOn(http, 'createServer').mockImplementation(((...args: Parameters<typeof http.createServer>) => {
    const server = (original as (...inner: unknown[]) => http.Server)(...args);
    created.push(server);
    return server;
  }) as typeof http.createServer);
  return {
    server: () => {
      if (created.length !== 1) throw new Error(`expected one server, saw ${created.length}`);
      return created[0] as http.Server;
    },
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('service fatal routing (fake timers)', () => {
  it('a fatal store error in a handler calls onFatal and answers 500', async () => {
    const faults: Faults = new Map();
    const env = await startService({ fakeTimers: true, onFatal: true, wrapStore: faultyStore(faults) });
    const fatal = sqliteError(SQLITE_IOERR, 'disk I/O error');
    faults.set('getSession', fatal);

    expectError(await env.http('GET', '/v1/sessions/ses_any'), 500, 'internal_error');

    expect(env.fatals).toEqual([fatal]);
    expect(env.fatals[0]).toBe(fatal);
    expect(env.errors).toEqual([]);
  });

  it('a fatal sweeper error calls onFatal', async () => {
    const faults: Faults = new Map();
    const env = await startService({ fakeTimers: true, onFatal: true, sweepIntervalMs: SWEEP_INTERVAL_MS, wrapStore: faultyStore(faults) });
    const fatal = sqliteError(SQLITE_CORRUPT, 'database disk image is malformed');
    faults.set('expireApprovals', fatal);

    env.timers?.advance(SWEEP_INTERVAL_MS);

    expect(env.fatals).toEqual([fatal]);
    expect(env.errors).toEqual([]);
  });

  it('a fatal data-version poll error calls onFatal', async () => {
    const faults: Faults = new Map();
    const env = await startService({ fakeTimers: true, onFatal: true, dataVersionPollMs: POLL_INTERVAL_MS, wrapStore: faultyStore(faults) });
    const fatal = sqliteError(SQLITE_IOERR, 'disk I/O error');
    faults.set('dataVersion', fatal);

    env.timers?.advance(POLL_INTERVAL_MS);

    expect(env.fatals).toEqual([fatal]);
    expect(env.errors).toEqual([]);
  });

  it('a fatal cancelUpstream error calls onFatal', async () => {
    const fatal = sqliteError(SQLITE_IOERR, 'disk I/O error');
    const env = await startService({
      fakeTimers: true,
      sweepIntervalMs: 1000,
      onFatal: true,
      cancelUpstream: async () => {
        throw fatal;
      },
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id);

    expect((await env.http('POST', `/v1/runs/${run.id}/cancel`)).status).toBe(202);
    env.timers?.advance(1000);

    await waitUntil(() => env.fatals.length > 0 || env.errors.length > 0, 3000, 'the cancelUpstream failure to be reported');
    expect(env.fatals).toEqual([fatal]);
    expect(env.errors).toEqual([]);
  });

  it('a fatal store error while reading an SSE stream calls onFatal', async () => {
    const faults: Faults = new Map();
    const env = await startService({ fakeTimers: true, onFatal: true, wrapStore: faultyStore(faults) });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const corrupt = sqliteError(SQLITE_CORRUPT, 'database disk image is malformed');
    faults.set('readRunEvents', corrupt);

    const runStream = await env.stream(`/v1/runs/${run.id}/events`, { headers: { 'last-event-id': '0' } });
    expect(runStream.status).toBe(200);
    await waitUntil(() => env.fatals.length > 0 || env.errors.length > 0, 3000, 'the run stream read failure to be reported');
    expect(env.fatals).toEqual([corrupt]);
    expect(env.errors).toEqual([]);

    const ioerr = sqliteError(SQLITE_IOERR, 'disk I/O error');
    faults.set('readSessionEvents', ioerr);
    const sessionStream = await env.stream(`/v1/sessions/${session.id}/events`, { headers: { 'last-event-id': '0' }, idField: 'id' });
    expect(sessionStream.status).toBe(200);
    await waitUntil(() => env.fatals.length > 1 || env.errors.length > 0, 3000, 'the session stream read failure to be reported');
    expect(env.fatals).toEqual([corrupt, ioerr]);
    expect(env.errors).toEqual([]);
  });

  it("a server 'error' event calls onFatal", async () => {
    const capture = captureServer();
    const env = await startService({ fakeTimers: true, onFatal: true });
    const failure = Object.assign(new Error('the listening socket failed'), { code: 'EBADF' });

    expect(() => capture.server().emit('error', failure)).not.toThrow();

    expect(env.fatals).toEqual([failure]);
    expect(env.errors).toEqual([]);
  });

  it("a server 'error' event without onFatal goes to onError", async () => {
    const capture = captureServer();
    const env = await startService({ fakeTimers: true });
    const failure = new Error('the listening socket failed');

    expect(() => capture.server().emit('error', failure)).not.toThrow();

    expect(env.errors).toEqual([failure]);
  });

  it('a non-fatal handler error calls onError only', async () => {
    const faults: Faults = new Map();
    const env = await startService({ fakeTimers: true, onFatal: true, wrapStore: faultyStore(faults) });
    const busy = sqliteError(SQLITE_BUSY, 'database is locked');
    faults.set('getSession', busy);
    expectError(await env.http('GET', '/v1/sessions/ses_any'), 500, 'internal_error');

    const plain = new Error('a plain failure');
    faults.set('getSession', plain);
    expectError(await env.http('GET', '/v1/sessions/ses_any'), 500, 'internal_error');

    expect(env.errors).toEqual([busy, plain]);
    expect(env.fatals).toEqual([]);
  });

  it('without onFatal every error goes to onError', async () => {
    const faults: Faults = new Map();
    const env = await startService({ fakeTimers: true, sweepIntervalMs: SWEEP_INTERVAL_MS, wrapStore: faultyStore(faults) });
    const session = await env.createSession();
    const run = await env.createRun(session.id);

    const handlerFatal = sqliteError(SQLITE_IOERR, 'disk I/O error');
    faults.set('getRun', handlerFatal);
    expectError(await env.http('GET', `/v1/runs/${run.id}`), 500, 'internal_error');

    const sweepFatal = sqliteError(SQLITE_CORRUPT, 'database disk image is malformed');
    faults.set('expireApprovals', sweepFatal);
    env.timers?.advance(SWEEP_INTERVAL_MS);

    expect(env.errors).toEqual([handlerFatal, sweepFatal]);
    expect(env.fatals).toEqual([]);
  });
});
