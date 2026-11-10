import { describe, expect, it } from 'vitest';
import { SERVER_KINDS } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';
import { DETECTION_BODY_MAX_BYTES, IDENTITY_READ_TIMEOUT_MS, detectLocalServers } from '../src/index.ts';
import type { DetectFetch } from '../src/index.ts';
import { START_MS } from './gateway-helpers.ts';
import { localOnly, noManagedHost } from './detect-kinds-support.ts';

const GOOD = 'http://127.0.0.1:7001';
const SILENT = 'http://127.0.0.1:7002';

const CHUNK_BYTES = 64 * 1024;

const encoder = new TextEncoder();

const jsonBody = (value: unknown): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield encoder.encode(JSON.stringify(value));
  })();

const answering = (routes: Readonly<Record<string, unknown>>) => (url: string) => {
  const body = Object.hasOwn(routes, url) ? routes[url] : undefined;
  return Promise.resolve(body === undefined ? { ok: false, body: jsonBody({}) } : { ok: true, body: jsonBody(body) });
};

const GOOD_ROUTES = { [`${GOOD}/v1/models`]: { object: 'list', data: [{ id: 'served-model' }] } };

const neverAnswering = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const search = (fetchFn: DetectFetch, candidates: readonly string[], signal: AbortSignal = new AbortController().signal) =>
  detectLocalServers({ candidates, typed: [], signal, fetch: fetchFn, ...noManagedHost }).then(localOnly);

describe('detection is bounded by the limits of each request and by the signal of the search (design-model-names 4.14)', () => {
  it('counts an answer over the body cap as no answer and cancels its stream', async () => {
    const streams: Array<{ produced: number; cancelled: boolean }> = [];
    const oversized = (): AsyncIterable<Uint8Array> => {
      const stream = { produced: 0, cancelled: false };
      streams.push(stream);
      return (async function* () {
        try {
          for (;;) {
            stream.produced += CHUNK_BYTES;
            yield new Uint8Array(CHUNK_BYTES).fill(0x20);
          }
        } finally {
          stream.cancelled = true;
        }
      })();
    };
    const fetchFn: DetectFetch = async () => ({ ok: true, body: oversized() });
    expect(await search(fetchFn, [GOOD])).toEqual([]);
    expect(streams.length).toBeGreaterThan(0);
    for (const stream of streams) {
      expect(stream.cancelled).toBe(true);
      expect(stream.produced).toBeLessThanOrEqual(DETECTION_BODY_MAX_BYTES + CHUNK_BYTES);
    }
  });

  it('ends a candidate that accepts and never sends headers at the identity-read limit, and makes none of its remaining requests', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const asked: string[] = [];
    const fetchFn: DetectFetch = (url) => {
      asked.push(url);
      return new Promise((_resolve, reject) => {
        timers.setTimeout(() => reject(new TypeError('fetch failed')), IDENTITY_READ_TIMEOUT_MS);
      });
    };
    const pending = search(fetchFn, [SILENT]);
    await waitFor(() => timers.pending().length === 1, { description: 'the first request waiting' });
    timers.advance(IDENTITY_READ_TIMEOUT_MS - 1);
    expect(asked).toHaveLength(1);
    timers.advance(1);
    expect(await pending).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(timers.pending()).toEqual([]);
  });

  it('still reports a server that answers beside one that never does', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const good = answering(GOOD_ROUTES);
    const fetchFn: DetectFetch = (url) =>
      url.startsWith(SILENT)
        ? new Promise((_resolve, reject) => {
            timers.setTimeout(() => reject(new TypeError('fetch failed')), IDENTITY_READ_TIMEOUT_MS);
          })
        : good(url);
    const pending = search(fetchFn, [SILENT, GOOD]);
    await waitFor(() => timers.pending().length === 1, { description: 'the silent server waiting' });
    timers.advance(IDENTITY_READ_TIMEOUT_MS);
    expect((await pending).map((server) => server.address)).toEqual([`${GOOD}/v1`]);
  });

  it('ends every request when the search signal is aborted, with no timer left', async () => {
    const timers = createFakeTimers(createFakeClock(START_MS));
    const cancel = new AbortController();
    const asked: string[] = [];
    const fetchFn: DetectFetch = (url, init) => {
      asked.push(url);
      return neverAnswering(init.signal);
    };
    const pending = search(fetchFn, [SILENT, GOOD], cancel.signal);
    await waitFor(() => asked.length === 2, { description: 'both candidates asked' });
    cancel.abort();
    expect(await pending).toEqual([]);
    expect(asked).toHaveLength(2);
    expect(timers.pending()).toEqual([]);
  });

  it('issues at most two requests per kind for a candidate', async () => {
    const asked: string[] = [];
    const fetchFn: DetectFetch = async (url) => {
      asked.push(url);
      return { ok: true, body: jsonBody({ version: '1', models: 'not a list', data: 'not a list' }) };
    };
    expect(await search(fetchFn, [GOOD])).toEqual([]);
    expect(asked).toEqual([`${GOOD}/api/version`, `${GOOD}/api/tags`, `${GOOD}/api/v0/models`, `${GOOD}/v1/models`]);
    expect(asked.length).toBeLessThanOrEqual(2 * SERVER_KINDS.length);
  });

  it('ends when the controller of the flow is aborted, whatever the process-close signal does', async () => {
    const flow = new AbortController();
    const closing = new AbortController();
    const fetchFn: DetectFetch = (_url, init) => neverAnswering(init.signal);
    const pending = search(fetchFn, [SILENT], AbortSignal.any([flow.signal, closing.signal]));
    flow.abort();
    expect(await pending).toEqual([]);
    expect(closing.signal.aborted).toBe(false);
  });
});
