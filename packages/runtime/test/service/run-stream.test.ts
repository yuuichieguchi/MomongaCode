import { describe, expect, it } from 'vitest';
import { afterMicrotasks, fixtureCompactionItem } from '@momonga/testkit';
import { LEASE_MS, START_MS, expectError, openStore, startService, waitUntil } from './helpers.ts';
import type { ServiceEnv, StreamEvent } from './helpers.ts';

const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);

const seqsOf = (events: readonly StreamEvent[]): number[] => events.map((event) => event.seq as number);

const runningRunWithNotices = async (env: ServiceEnv, count: number) => {
  const session = await env.createSession();
  const run = await env.createRun(session.id);
  const claim = env.claimRun(run.id);
  env.append(claim, env.notices(count));
  const current = await env.getRun(run.id);
  return { session, run, claim, lastSeq: current.lastSeq as number };
};

describe('run stream cursor', () => {
  it('delivers k+1..end exactly once from Last-Event-ID', async () => {
    const env = await startService();
    const { run, claim, lastSeq } = await runningRunWithNotices(env, 6);
    const k = lastSeq - 4;

    const stream = await env.stream(`/v1/runs/${run.id}/events`, { headers: { 'last-event-id': String(k) } });
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
    const delivered = await stream.until((event) => event.seq === lastSeq);
    expect(seqsOf(delivered)).toEqual(range(k + 1, lastSeq));

    env.append(claim, env.notices(1, 'later'));
    const next = await stream.next();
    expect(next).toMatchObject({ seq: lastSeq + 1, type: 'notice', message: 'later1' });
    expect(seqsOf(stream.events)).toEqual(range(k + 1, lastSeq + 1));
  });

  it('prefers Last-Event-ID over ?after=', async () => {
    const env = await startService();
    const { run, lastSeq } = await runningRunWithNotices(env, 5);
    const stream = await env.stream(`/v1/runs/${run.id}/events?after=1`, { headers: { 'last-event-id': String(lastSeq - 1) } });
    const delivered = await stream.until((event) => event.seq === lastSeq);
    expect(seqsOf(delivered)).toEqual([lastSeq]);
  });

  it('uses ?after= when the header is absent and 0 when neither is given', async () => {
    const env = await startService();
    const { run, lastSeq } = await runningRunWithNotices(env, 3);
    const after = await env.stream(`/v1/runs/${run.id}/events?after=2`);
    expect(seqsOf(await after.until((event) => event.seq === lastSeq))).toEqual(range(3, lastSeq));
    const fromStart = await env.stream(`/v1/runs/${run.id}/events`);
    expect(seqsOf(await fromStart.until((event) => event.seq === lastSeq))).toEqual(range(1, lastSeq));
  });

  it.each(['abc', '-1', '1.5', '', '1e2'])('rejects the cursor %j with 400', async (cursor) => {
    const env = await startService();
    const { run } = await runningRunWithNotices(env, 2);
    const viaQuery = await env.stream(`/v1/runs/${run.id}/events?after=${encodeURIComponent(cursor)}`);
    expect(viaQuery.status).toBe(400);
    expect((viaQuery as unknown as { json: unknown }).json).toMatchObject({ error: { code: 'invalid_request' } });
    if (cursor !== '') {
      const viaHeader = await env.stream(`/v1/runs/${run.id}/events`, { headers: { 'last-event-id': cursor } });
      expect(viaHeader.status).toBe(400);
    }
  });

  it('rejects a cursor above lastSeq with 400', async () => {
    const env = await startService();
    const { run, lastSeq } = await runningRunWithNotices(env, 2);
    expect((await env.stream(`/v1/runs/${run.id}/events?after=${lastSeq + 1}`)).status).toBe(400);
    expect((await env.stream(`/v1/runs/${run.id}/events`, { headers: { 'last-event-id': String(lastSeq + 1) } })).status).toBe(400);
    expect((await env.stream(`/v1/runs/${run.id}/events?after=${lastSeq}`)).status).toBe(200);
  });

  it('answers an unknown run with 404 before streaming', async () => {
    const env = await startService();
    const stream = await env.stream('/v1/runs/run_missing/events');
    expect(stream.status).toBe(404);
    expect((stream as unknown as { json: unknown }).json).toMatchObject({ error: { type: 'not_found', code: 'not_found' } });
  });
});

describe('run stream under concurrent writes', () => {
  it('delivers every seq exactly once and in order to subscribers at several cursors while 500 events are appended', async () => {
    const env = await startService();
    const { run, claim, lastSeq: initial } = await runningRunWithNotices(env, 3);
    const early = await env.stream(`/v1/runs/${run.id}/events`);
    const atEnd = await env.stream(`/v1/runs/${run.id}/events?after=${initial}`);
    const lateCursors: number[] = [];
    const late: Awaited<ReturnType<typeof env.stream>>[] = [];

    for (let batch = 0; batch < 50; batch += 1) {
      env.append(claim, env.notices(10, `b${batch}-`));
      if (batch === 20) {
        const cursor = (await env.getRun(run.id)).lastSeq as number;
        lateCursors.push(cursor - 7);
        late.push(await env.stream(`/v1/runs/${run.id}/events`, { headers: { 'last-event-id': String(cursor - 7) } }));
      }
      await afterMicrotasks();
    }
    const transition = await env.store.transition(claim, ['RUNNING'], 'COMPLETED');
    expect(transition.kind).toBe('ok');
    const finalSeq = (await env.getRun(run.id)).lastSeq as number;
    expect(finalSeq).toBeGreaterThanOrEqual(initial + 501);

    const lateStream = late[0];
    const lateCursor = lateCursors[0];
    if (lateStream === undefined || lateCursor === undefined) throw new Error('late subscriber missing');
    expect(seqsOf(await early.toEnd(20_000))).toEqual(range(1, finalSeq));
    expect(seqsOf(await atEnd.toEnd(20_000))).toEqual(range(initial + 1, finalSeq));
    expect(seqsOf(await lateStream.toEnd(20_000))).toEqual(range(lateCursor + 1, finalSeq));
  });
});

describe('run stream termination', () => {
  it('ends after a normal terminal status', async () => {
    const env = await startService();
    const { run, claim, lastSeq } = await runningRunWithNotices(env, 2);
    const stream = await env.stream(`/v1/runs/${run.id}/events?after=${lastSeq}`);
    await waitUntil(() => env.notifier.subscriberCount() === 1, 5000, 'the subscriber to register');

    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    const rest = await stream.toEnd();
    expect(rest.at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
    expect(seqsOf(rest)).toEqual(range(lastSeq + 1, (await env.getRun(run.id)).lastSeq));
    await waitUntil(() => env.notifier.subscriberCount() === 0, 5000, 'the subscriber to unregister');
  });

  it('ends after a dead letter appended by claim', async () => {
    const env = await startService({ maxAttempts: 1 });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    env.claimRun(run.id, 'doomed-worker');
    const before = await env.getRun(run.id);
    const stream = await env.stream(`/v1/runs/${run.id}/events?after=${before.lastSeq}`);
    await waitUntil(() => env.notifier.subscriberCount() === 1, 5000, 'the subscriber to register');

    env.clock.advance(LEASE_MS + 1);
    expect(env.store.claim('next-worker')).toBeNull();

    const after = await env.getRun(run.id);
    expect(['FAILED', 'STOPPED']).toContain(after.status);
    const rest = await stream.toEnd();
    expect(rest.at(-1)).toMatchObject({ type: 'run.status', to: after.status });
    expect(seqsOf(rest)).toEqual(range(before.lastSeq + 1, after.lastSeq));
  });

  it('ends immediately when the cursor is already at the end of a terminal run', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    await env.http('POST', `/v1/runs/${run.id}/cancel`);
    const terminal = await env.getRun(run.id);
    expect(terminal.status).toBe('CANCELLED');

    const atEnd = await env.stream(`/v1/runs/${run.id}/events?after=${terminal.lastSeq}`);
    expect(atEnd.status).toBe(200);
    expect(await atEnd.toEnd(2000)).toEqual([]);

    const fromStart = await env.stream(`/v1/runs/${run.id}/events`);
    expect(seqsOf(await fromStart.toEnd(2000))).toEqual(range(1, terminal.lastSeq));
  });
});

describe('run stream liveness', () => {
  it('sends a keep-alive comment every keepAliveMs while idle', async () => {
    const env = await startService({ fakeTimers: true, keepAliveMs: 15_000 });
    const timers = env.timers;
    if (timers === undefined) throw new Error('fake timers missing');
    const { run, lastSeq } = await runningRunWithNotices(env, 1);
    const stream = await env.stream(`/v1/runs/${run.id}/events?after=${lastSeq}`);
    await waitUntil(() => env.notifier.subscriberCount() === 1, 5000, 'the subscriber to register');
    await waitUntil(() => timers.pending().some((timer) => timer.delayMs === 15_000), 5000, 'the keep-alive timer');

    timers.advance(15_000);
    expect(await stream.nextComment()).toBe('keep-alive');
    await waitUntil(() => timers.pending().some((timer) => timer.delayMs === 15_000), 5000, 'the next keep-alive timer');
    timers.advance(15_000);
    expect(await stream.nextComment()).toBe('keep-alive');
    expect(stream.events).toEqual([]);
  });

  it('returns subscriberCount to 0 after the client disconnects', async () => {
    const env = await startService();
    const { run, lastSeq } = await runningRunWithNotices(env, 1);
    const first = await env.stream(`/v1/runs/${run.id}/events?after=${lastSeq}`);
    const second = await env.stream(`/v1/runs/${run.id}/events?after=${lastSeq}`);
    await waitUntil(() => env.notifier.subscriberCount() === 2, 5000, 'two subscribers');

    first.close();
    await waitUntil(() => env.notifier.subscriberCount() === 1, 5000, 'one subscriber after the first disconnect');
    second.close();
    await waitUntil(() => env.notifier.subscriberCount() === 0, 5000, 'no subscribers');
  });

  it('delivers events written through a second store connection via the data_version fallback', async () => {
    const env = await startService({ dataVersionPollMs: 20 });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const initial = await env.getRun(run.id);
    const stream = await env.stream(`/v1/runs/${run.id}/events?after=${initial.lastSeq}`);
    await waitUntil(() => env.notifier.subscriberCount() === 1, 5000, 'the subscriber to register');

    const second = openStore(env.layout.dbPath, env.clock);
    const claim = second.claim('remote-worker');
    if (claim === null) throw new Error('remote worker could not claim');
    expect(second.append(claim, [{ type: 'notice', level: 'info', message: 'from afar' }]).kind).toBe('ok');

    const seen = await stream.until((event) => event.type === 'notice');
    expect(seen.at(-1)).toMatchObject({ type: 'notice', message: 'from afar', runId: run.id });
  });
});

describe('run stream projection', () => {
  it('omits lease tokens and reduces model.requested, run.started, context.compacted and instructions.loaded', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    const digest = 'd'.repeat(64);
    env.append(claim, [
      { type: 'run.started', attempt: 1, now: START_MS, pins: { gateway: 'pinned-secret-pin' } },
      { type: 'instructions.loaded', path: '/p/AGENTS.md', content: 'private instruction text' },
      { type: 'model.requested', step: 1, attempt: 1, digest, body: { input: 'private model body' } },
      { type: 'notice', level: 'warning', message: 'passed through' },
    ]);
    const lastSeq = (await env.getRun(run.id)).lastSeq as number;

    const stream = await env.stream(`/v1/runs/${run.id}/events`);
    const frames = await stream.until((event) => event.seq === lastSeq);

    for (const frame of frames) {
      expect(frame).not.toHaveProperty('leaseToken');
      expect(frame).toMatchObject({ runId: run.id, sessionId: session.id, id: expect.any(Number), seq: expect.any(Number), createdAt: expect.any(Number) });
    }
    const keysOf = (event: StreamEvent | undefined): string[] => Object.keys(event ?? {}).filter((key) => !['id', 'runId', 'sessionId', 'seq', 'createdAt', 'type', 'step'].includes(key)).sort();
    const modelRequested = frames.find((event) => event.type === 'model.requested');
    expect(modelRequested).toMatchObject({ step: 1, attempt: 1, digest });
    expect(keysOf(modelRequested)).toEqual(['attempt', 'digest']);
    const started = frames.filter((event) => event.type === 'run.started');
    expect(started.length).toBeGreaterThan(0);
    for (const event of started) expect(keysOf(event)).toEqual(['attempt']);
    const instructions = frames.find((event) => event.type === 'instructions.loaded');
    expect(keysOf(instructions)).toEqual(['path']);
    expect(instructions).toMatchObject({ path: '/p/AGENTS.md' });
    expect(frames.find((event) => event.type === 'notice' && event.message === 'passed through')).toMatchObject({ level: 'warning' });
    const serialized = JSON.stringify(frames);
    for (const secret of ['pinned-secret-pin', 'private instruction text', 'private model body']) expect(serialized).not.toContain(secret);
  });

  it('reduces context.compacted to its summary and replacedThroughSeq', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, env.notices(2));
    const through = (await env.getRun(run.id)).lastSeq as number;
    env.append(claim, [
      { type: 'context.compacted', item: fixtureCompactionItem('cmp_1', 'earlier work summarized'), summary: 'earlier work summarized', replacedThroughSeq: through },
    ]);
    const lastSeq = (await env.getRun(run.id)).lastSeq as number;
    const stream = await env.stream(`/v1/runs/${run.id}/events?after=${through}`);
    const frames = await stream.until((event) => event.seq === lastSeq);
    const compacted = frames.find((event) => event.type === 'context.compacted');
    expect(compacted).toMatchObject({ summary: 'earlier work summarized', replacedThroughSeq: through });
    expect(compacted).not.toHaveProperty('item');
    expect(JSON.stringify(frames)).not.toContain(fixtureCompactionItem('cmp_1', 'earlier work summarized').encrypted_content);
  });
});

