import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunNotifier } from '@momonga/runtime';
import type { RunEvent } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { afterMicrotasks, waitFor, createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { eventStreamResponse } from '../../src/service/event-stream.ts';
import { START_MS, expectError, onCleanup, openStore, startService, pollFor } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const runningRun = async (env: ServiceEnv) => {
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  const claim = env.claimRun(run.id);
  env.append(claim, env.notices(2));
  return { session, run, claim, lastSeq: (await env.getRun(run.id)).lastSeq as number };
};

describe('SW1 event stream read failure', () => {
  it('unsubscribes, reports the error once through onError and removes its abort listeners', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const notifier = createRunNotifier();
    const closeController = new AbortController();
    const requestController = new AbortController();
    const failure = new Error('read exploded');
    const errors: unknown[] = [];

    const response = eventStreamResponse({
      source: {
        read: () => {
          throw failure;
        },
        cursorOf: () => 0,
      },
      cursor: 0,
      watch: (wake) => notifier.watchRun('run_x', wake),
      timers,
      keepAliveMs: 15_000,
      signals: [closeController.signal, requestController.signal],
      onError: (error: unknown) => errors.push(error),
    });
    expect(notifier.subscriberCount()).toBe(1);

    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('stream body missing');
    await expect(reader.read()).rejects.toBe(failure);

    expect(errors).toEqual([failure]);
    expect(notifier.subscriberCount()).toBe(0);
    expect(getEventListeners(closeController.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(requestController.signal, 'abort')).toHaveLength(0);
    expect(timers.pending()).toEqual([]);
  });
});

describe('SW2 data_version poll failure', () => {
  it('reports a throwing dataVersion through onError, keeps polling and still wakes subscribers later', async () => {
    let failNext = false;
    const failure = new Error('data_version failed');
    const env = await startService({
      fakeTimers: true,
      dataVersionPollMs: 50,
      wrapStore: (store) =>
        new Proxy(store, {
          get: (target, property, receiver) => {
            if (property !== 'dataVersion') return Reflect.get(target, property, receiver);
            return () => {
              if (failNext) {
                failNext = false;
                throw failure;
              }
              return target.dataVersion();
            };
          },
        }) as RuntimeStore,
    });
    const timers = env.timers;
    if (timers === undefined) throw new Error('fake timers missing');
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const initial = (await env.getRun(run.id)).lastSeq as number;
    const stream = await env.stream(`/v1/runs/${run.id}/events?after=${initial}`);
    await pollFor(() => env.notifier.subscriberCount() === 1, 5000, 'the subscriber to register');

    failNext = true;
    expect(() => timers.advance(50)).not.toThrow();
    expect(env.errors).toEqual([failure]);

    const second = openStore(env.layout.dbPath, env.clock);
    const claim = second.claim('remote-worker');
    if (claim === null) throw new Error('remote worker could not claim');
    expect(second.append(claim, [{ type: 'notice', level: 'info', message: 'after the failure' }]).kind).toBe('ok');
    timers.advance(50);

    const seen = await stream.until((event) => event.type === 'notice');
    expect(seen.at(-1)).toMatchObject({ message: 'after the failure' });
    expect(env.errors).toEqual([failure]);
  });
});

describe.skipIf(process.getuid?.() === 0)('SW3 unreadable cwd', () => {
  it('answers create and list with 400 invalid_request naming cwd instead of 500', async () => {
    const env = await startService();
    const locked = path.join(env.layout.root, 'locked');
    const inside = path.join(locked, 'p');
    fs.mkdirSync(inside, { recursive: true });
    fs.chmodSync(locked, 0o000);
    onCleanup(() => fs.chmodSync(locked, 0o700));

    const created = await env.http('POST', '/v1/sessions', { body: { cwd: inside, env: {} } });
    expectError(created, 400, 'invalid_request');
    expect(created.json.error.param).toBe('cwd');

    const listed = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(inside)}`);
    expectError(listed, 400, 'invalid_request');
    expect(listed.json.error.param).toBe('cwd');
  });
});

describe('SW4 malformed JSON message', () => {
  it('uses a fixed message that does not echo the body', async () => {
    const env = await startService();
    const session = await env.createSession();
    const secret = 'hunter2-malformed-secret';

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { raw: `{"input": ${secret}}` });

    expectError(response, 400, 'invalid_request');
    expect(response.json.error.message).toBe('the request body is not valid JSON');
    expect(response.text).not.toContain(secret);
  });
});

describe('SS1 cursor error param', () => {
  it('names Last-Event-ID when the header was the source and after when the query was', async () => {
    const env = await startService();
    const { run, session, lastSeq } = await runningRun(env);
    const errorOf = (stream: unknown): { code: string; param?: string } => (stream as { json: { error: { code: string; param?: string } } }).json.error;

    const byHeader = await env.stream(`/v1/runs/${run.id}/events`, { headers: { 'last-event-id': 'x' } });
    expect(byHeader.status).toBe(400);
    expect(errorOf(byHeader)).toMatchObject({ code: 'invalid_request', param: 'Last-Event-ID' });

    const byQuery = await env.stream(`/v1/runs/${run.id}/events?after=${lastSeq + 1}`);
    expect(byQuery.status).toBe(400);
    expect(errorOf(byQuery)).toMatchObject({ code: 'invalid_request', param: 'after' });

    const headerWins = await env.stream(`/v1/runs/${run.id}/events?after=1`, { headers: { 'last-event-id': String(lastSeq + 1) } });
    expect(headerWins.status).toBe(400);
    expect(errorOf(headerWins)).toMatchObject({ param: 'Last-Event-ID' });

    const sessionHeader = await env.stream(`/v1/sessions/${session.id}/events`, { idField: 'id', headers: { 'last-event-id': '-1' } });
    expect(sessionHeader.status).toBe(400);
    expect(errorOf(sessionHeader)).toMatchObject({ param: 'Last-Event-ID' });

    const sessionQuery = await env.stream(`/v1/sessions/${session.id}/events?after=abc`, { idField: 'id' });
    expect(sessionQuery.status).toBe(400);
    expect(errorOf(sessionQuery)).toMatchObject({ param: 'after' });
  });
});

describe('SS2 HEAD and OPTIONS', () => {
  it('answers HEAD on a JSON route like GET without a body', async () => {
    const env = await startService();
    const response = await env.client.request({ method: 'HEAD', path: '/v1/health' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(await response.text()).toBe('');
  });

  it('answers HEAD on an SSE route with headers only and no subscription', async () => {
    const env = await startService();
    const { run } = await runningRun(env);
    const response = await env.client.request({ method: 'HEAD', path: `/v1/runs/${run.id}/events` });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(await response.text()).toBe('');
    expect(env.notifier.subscriberCount()).toBe(0);
    await afterMicrotasks();
    expect(env.notifier.subscriberCount()).toBe(0);
  });

  it('answers OPTIONS with 405 and Allow', async () => {
    const env = await startService();
    const { run } = await runningRun(env);
    const response = await env.client.request({ method: 'OPTIONS', path: `/v1/runs/${run.id}` });
    await response.text();
    expect(response.status).toBe(405);
    expect((response.headers['allow'] ?? '').split(',').map((method) => method.trim())).toContain('GET');
  });
});

describe('SS3 single clock read for run timestamps', () => {
  it('stores deadlineAt exactly timeoutMs after createdAt even when the clock moves between reads', async () => {
    let now = START_MS;
    const ticking: FakeClock = {
      now: () => {
        now += 1;
        return now;
      },
      monotonicMs: () => now,
      advance: (ms) => {
        now += ms;
      },
      set: (ms) => {
        now = ms;
      },
      stepWall: () => {
        throw new Error('this clock has one value and cannot step its wall time alone');
      },
    };
    const env = await startService({ clock: ticking });
    const session = await env.createSession();

    const withTimeout = await env.createRun(session.id, { timeoutMs: 60_000 });
    const withDefault = await env.createRun(session.id);

    expect(withTimeout.deadlineAt - withTimeout.createdAt).toBe(60_000);
    expect(withDefault.deadlineAt - withDefault.createdAt).toBe(6 * 3_600_000);
  });
});

describe('SS5 coverage gaps', () => {
  it('splits pages at the 1 MiB limit without a gap', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    const big = 'x'.repeat(Math.floor(0.6 * 1024 * 1024));
    env.append(claim, [
      { type: 'notice', level: 'info', message: `A${big}` },
      { type: 'notice', level: 'info', message: `B${big}` },
      { type: 'notice', level: 'info', message: 'C' },
    ]);
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    const lastSeq = (await env.getRun(run.id)).lastSeq as number;

    const frames = await (await env.stream(`/v1/runs/${run.id}/events`)).toEnd();

    expect(frames.map((event) => event.seq)).toEqual(Array.from({ length: lastSeq }, (_, index) => index + 1));
    expect(frames.filter((event) => event.type === 'notice').map((event) => String(event.message).slice(0, 1))).toEqual(['A', 'B', 'C']);
  });

  it('puts at most 1 MiB of frames in one pull so the second large event arrives on a later read', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const notifier = createRunNotifier();
    const big = 'x'.repeat(Math.floor(0.6 * 1024 * 1024));
    const events: RunEvent[] = [1, 2].map((seq) => ({
      type: 'notice',
      level: 'info',
      message: `${seq}${big}`,
      id: seq,
      runId: 'run_big',
      sessionId: 'ses_big',
      seq,
      step: 0,
      leaseToken: 1,
      createdAt: START_MS,
    }));
    const response = eventStreamResponse({
      source: {
        read: (cursor, limit) => ({ events: events.filter((event) => event.seq > cursor).slice(0, limit), endsAt: 2 }),
        cursorOf: (event) => (event as RunEvent).seq,
      },
      cursor: 0,
      watch: (wake) => notifier.watchRun('run_big', wake),
      timers,
      keepAliveMs: 15_000,
      signals: [],
      onError: () => undefined,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('stream body missing');
    const decoder = new TextDecoder();
    const idsIn = (chunk: Uint8Array | undefined): string[] => [...decoder.decode(chunk).matchAll(/^id: (\d+)$/gm)].map((match) => match[1] ?? '');

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(idsIn(first.value)).toEqual(['1']);
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(idsIn(second.value)).toEqual(['2']);
    expect((await reader.read()).done).toBe(true);
  });

  it('rejects a session-stream cursor above the maximum or malformed with 400', async () => {
    const env = await startService();
    const { session } = await runningRun(env);
    const max = env.store.sessionMaxEventId(session.id);
    for (const cursor of [String(max + 1), '1.5', 'abc']) {
      const stream = await env.stream(`/v1/sessions/${session.id}/events?after=${cursor}`, { idField: 'id' });
      expect(stream.status).toBe(400);
    }
  });

  it('answers wrong methods on PATCH and POST routes with 405 and Allow', async () => {
    const env = await startService();
    const { session, run } = await runningRun(env);
    const allowOf = (header: string | undefined): string[] =>
      (header ?? '').split(',').map((method) => method.trim()).filter((method) => method !== '' && method !== 'HEAD' && method !== 'OPTIONS').sort();
    const cases: [string, string, string[]][] = [
      ['POST', `/v1/sessions/${session.id}`, ['GET', 'PATCH']],
      ['PUT', `/v1/sessions/${session.id}`, ['GET', 'PATCH']],
      ['PATCH', `/v1/runs/${run.id}/cancel`, ['POST']],
      ['PATCH', '/v1/sessions', ['GET', 'POST']],
      ['PATCH', '/v1/approvals/apr_x', ['GET', 'POST']],
    ];
    for (const [method, target, allowed] of cases) {
      const response = await env.http(method, target, { body: {} });
      expect({ method, target, status: response.status, allow: allowOf(response.headers['allow']) }).toEqual({ method, target, status: 405, allow: allowed });
    }
  });

  it('leaves no subscribers and no abort listeners after close with several open streams', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const notifier = createRunNotifier();
    const closeController = new AbortController();
    const responses = Array.from({ length: 3 }, (_, index) =>
      eventStreamResponse({
        source: { read: () => ({ events: [], endsAt: undefined }), cursorOf: () => 0 },
        cursor: 0,
        watch: (wake) => notifier.watchRun(`run_${index}`, wake),
        timers,
        keepAliveMs: 15_000,
        signals: [closeController.signal],
        onError: () => undefined,
      }),
    );
    const reads = responses.map((response) => response.body?.getReader().read());
    await waitFor(() => notifier.subscriberCount() === 3, { description: 'three subscribers' });
    expect(notifier.subscriberCount()).toBe(3);

    closeController.abort();
    await Promise.all(reads);

    expect(notifier.subscriberCount()).toBe(0);
    expect(getEventListeners(closeController.signal, 'abort')).toHaveLength(0);
    expect(timers.pending()).toEqual([]);
  });

  it('ends several open service streams on close with subscriberCount back at 0', async () => {
    const env = await startService();
    const { run, lastSeq } = await runningRun(env);
    const streams = await Promise.all([0, 1, 2].map(() => env.stream(`/v1/runs/${run.id}/events?after=${lastSeq}`)));
    await pollFor(() => env.notifier.subscriberCount() === 3, 5000, 'three subscribers');

    await env.closeService();

    await pollFor(() => streams.every((stream) => stream.ended), 5000, 'every stream to end');
    expect(env.notifier.subscriberCount()).toBe(0);
  });
});
