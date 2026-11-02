import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { DEFAULT_TASK_POLL_MS, McpInputProtocolError, McpInputSuspension, McpTaskError, MIN_TASK_POLL_MS } from '@momonga/mcp';
import type { McpCheckpoint } from '@momonga/mcp';

const CALL_TIMEOUT_MS = 1_000_000;
const isPoll = (ms: number): boolean => ms !== CALL_TIMEOUT_MS;
import { settleTask } from '../src/tasks.ts';
import type { TaskMethod, TaskRequester } from '../src/tasks.ts';
import type { McpTimers } from '../src/timers.ts';
import { makeRemoteConnection, observedTimers, startHttpFixture, textOf } from './remote-harness.ts';

const setup = async (era: 'modern' | 'legacy' = 'modern') => {
  const fixture = await startHttpFixture({ era, taskPollIntervalMs: 1 });
  const timers = observedTimers(createFakeClock(1_000_000));
  const { connection } = makeRemoteConnection({ fixture, timers });
  await connection.listTools();
  return { fixture, timers, connection };
};

const startLongTask = async (fixture: Awaited<ReturnType<typeof startHttpFixture>>, timers: ReturnType<typeof observedTimers>, connection: Awaited<ReturnType<typeof setup>>['connection'], signal?: AbortSignal) => {
  const scheduled = timers.nextScheduled(isPoll);
  const outcome = connection.callTool({ name: 'long_task', arguments: {}, timeoutMs: CALL_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await scheduled;
  const [taskId] = fixture.taskIds();
  return { outcome, taskId: taskId as string };
};

const TASK_START_MS = 1_000_000;
const TASK_ID = 'task-1';
const iso = (ms: number): string => new Date(ms).toISOString();
const firingTimers: McpTimers = {
  setTimeout: (callback) => {
    queueMicrotask(callback);
    return undefined;
  },
  clearTimeout: () => undefined,
};
const accepted = { content: [{ type: 'text' as const, text: 'accepted' }] };
type SettleOverrides = { created: unknown; request: TaskRequester; signal?: AbortSignal; now?: () => number; trackCancel?: (outcome: Promise<void>) => void };
const settleOptions = (overrides: SettleOverrides) => ({
  start: { created: overrides.created },
  answers: {},
  request: overrides.request,
  timers: firingTimers,
  clock: { now: overrides.now ?? (() => TASK_START_MS) },
  signal: overrides.signal ?? new AbortController().signal,
  onCheckpoint: () => undefined,
  accept: () => accepted,
  trackCancel: overrides.trackCancel ?? ((outcome: Promise<void>) => void outcome.catch(() => undefined)),
});
const pastItsTtl = {
  taskId: TASK_ID,
  status: 'working',
  ttlMs: 5000,
  createdAt: iso(TASK_START_MS),
  lastUpdatedAt: iso(TASK_START_MS + 6000),
};
const rejection = (settling: Promise<unknown>): Promise<unknown> =>
  settling.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('settleTask when tasks/cancel fails', () => {
  it('keeps the ttl error and reports the cancel failure on cancelFailure, never on the cause chain', async () => {
    const reaped = new Error('task not found');
    const error = await rejection(settleTask(settleOptions({ created: pastItsTtl, request: async () => { throw reaped; } })));
    expect(error).toBeInstanceOf(McpTaskError);
    expect((error as McpTaskError).message).toContain('ttl of 5000ms');
    expect((error as McpTaskError).cancelFailure).toBe(reaped);
    expect((error as McpTaskError).cause).toBeUndefined();
  });

  it('keeps the input request parse error and reports the cancel failure on cancelFailure', async () => {
    const reaped = new Error('task not found');
    const malformed = { taskId: TASK_ID, status: 'input_required', inputRequests: 'not requests' };
    const error = await rejection(settleTask(settleOptions({ created: malformed, request: async () => { throw reaped; } })));
    expect(error).toBeInstanceOf(McpInputProtocolError);
    expect((error as McpInputProtocolError).cancelFailure).toBe(reaped);
    expect((error as McpInputProtocolError).cause).toBeUndefined();
  });

  it('rejects with the untouched abort reason at once while the cancel is still unanswered, and tracks the cancel outcome', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    const cancelAnswer = Promise.withResolvers<unknown>();
    const cancelSignals: (AbortSignal | undefined)[] = [];
    const request: TaskRequester = async (method, _params, signal) => {
      if (method === 'tasks/get') {
        controller.abort(reason);
        throw new Error('poll aborted');
      }
      cancelSignals.push(signal);
      return cancelAnswer.promise;
    };
    const tracked: Promise<void>[] = [];
    const working = { taskId: TASK_ID, status: 'working' };
    const thrown = await rejection(settleTask(settleOptions({ created: working, request, signal: controller.signal, trackCancel: (outcome) => void tracked.push(outcome) })));
    expect(thrown).toBe(reason);
    expect(Object.keys(reason)).toEqual([]);
    expect(reason.cause).toBeUndefined();
    expect(cancelSignals).toEqual([undefined]);
    expect(tracked).toHaveLength(1);
    const outcome = rejection(tracked[0] as Promise<void>);
    const refused = new Error('task not found');
    cancelAnswer.reject(refused);
    expect(await outcome).toBe(refused);
  });

  it('sends the cancel when the signal was already aborted before the first poll, and rejects with the reason', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    controller.abort(reason);
    const methods: TaskMethod[] = [];
    const request: TaskRequester = async (method) => {
      methods.push(method);
      return {};
    };
    const tracked: Promise<void>[] = [];
    const working = { taskId: TASK_ID, status: 'working' };
    expect(await rejection(settleTask(settleOptions({ created: working, request, signal: controller.signal, trackCancel: (outcome) => void tracked.push(outcome) })))).toBe(reason);
    await Promise.all(tracked);
    expect(methods).toEqual(['tasks/cancel']);
  });

  it('gives the cancel a signal that follows the abort of the call', async () => {
    const controller = new AbortController();
    const cancelSignals: (AbortSignal | undefined)[] = [];
    const request: TaskRequester = async (method, _params, signal) => {
      if (method === 'tasks/cancel') cancelSignals.push(signal);
      return {};
    };
    await rejection(settleTask(settleOptions({ created: pastItsTtl, request, signal: controller.signal })));
    expect(cancelSignals).toHaveLength(1);
    const [cancelSignal] = cancelSignals;
    expect(cancelSignal).toBeInstanceOf(AbortSignal);
    expect(cancelSignal?.aborted).toBe(false);
    controller.abort(new Error('run cancelled'));
    expect(cancelSignal?.aborted).toBe(true);
  });
});

describe('settleTask cancel budget', () => {
  it('leaves the cancel timeout to the requester, which applies the configured request timeout', async () => {
    const cancelArities: number[] = [];
    const request = async (...args: Parameters<TaskRequester>): Promise<unknown> => {
      if (args[0] === 'tasks/cancel') cancelArities.push(args.length);
      return {};
    };
    await rejection(settleTask(settleOptions({ created: pastItsTtl, request })));
    expect(cancelArities).toEqual([3]);
  });
});

describe('settleTask with ttlMs 0 on a real clock', () => {
  it('polls once before applying the ttl when the clock ticks between receiving the creating response and checking it', async () => {
    let tick = 0;
    const now = (): number => {
      tick += 1;
      return TASK_START_MS + tick;
    };
    const methods: TaskMethod[] = [];
    const request: TaskRequester = async (method) => {
      methods.push(method);
      return { taskId: TASK_ID, status: 'completed', result: {} };
    };
    const created = { taskId: TASK_ID, status: 'working', ttlMs: 0, createdAt: iso(TASK_START_MS), lastUpdatedAt: iso(TASK_START_MS) };
    await expect(settleTask(settleOptions({ created, request, now }))).resolves.toBe(accepted);
    expect(methods).toEqual(['tasks/get']);
  });
});

describe('tasks extension over streamable HTTP', () => {
  it('polls a returned task handle until it completes and returns the tool result', async () => {
    const { fixture, timers, connection } = await setup();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    expect(timers.pending().map((timer) => timer.delayMs)).toContain(MIN_TASK_POLL_MS);

    fixture.completeTask(taskId, 'task finished');
    timers.advance(MIN_TASK_POLL_MS);
    const settled = await outcome;
    expect('value' in settled && textOf(settled.value)).toBe('task finished');

    const polls = fixture.rpcRecords('tasks/get');
    expect(polls).toHaveLength(1);
    expect(polls[0]?.headers['mcp-name']).toBe(taskId);
    expect(polls[0]?.headers['mcp-method']).toBe('tasks/get');
    expect(fixture.rpcRecords('tools/call')).toHaveLength(1);
  });

  it('keeps polling while the task is working and honours the server interval above the floor', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 4000 });
    const timers = observedTimers(createFakeClock(1_000_000));
    const { connection } = makeRemoteConnection({ fixture, timers });
    await connection.listTools();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    expect(timers.pending().map((timer) => timer.delayMs)).toContain(4000);

    const second = timers.nextScheduled(isPoll);
    timers.advance(4000);
    await second;
    expect(fixture.rpcRecords('tasks/get')).toHaveLength(1);
    fixture.completeTask(taskId, 'late');
    timers.advance(4000);
    const settled = await outcome;
    expect('value' in settled && textOf(settled.value)).toBe('late');
    expect(fixture.rpcRecords('tasks/get')).toHaveLength(2);
  });

  it('sends tasks/cancel and stops polling when the call is aborted', async () => {
    const { fixture, timers, connection } = await setup();
    const controller = new AbortController();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection, controller.signal);
    controller.abort(new Error('run cancelled'));
    const settled = await outcome;
    expect('error' in settled && (settled.error as Error).message).toContain('run cancelled');
    await fixture.until(() => fixture.notes.some((note) => note.type === 'task_cancel'));
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toEqual([{ type: 'task_cancel', taskId }]);
    expect(fixture.rpcRecords('tasks/cancel')[0]?.headers['mcp-name']).toBe(taskId);
    expect(fixture.rpcRecords('tasks/get')).toHaveLength(0);
  });

  it('cancels the task when the call deadline passes before it finishes', async () => {
    const { fixture, timers, connection } = await setup();
    const scheduled = timers.nextScheduled((ms) => ms === MIN_TASK_POLL_MS);
    const outcome = connection.callTool({ name: 'long_task', arguments: {}, timeoutMs: 5000 }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await scheduled;
    timers.advance(5000);
    const settled = await outcome;
    expect('error' in settled && (settled.error as Error).message).toContain('did not finish within 5000ms');
    await fixture.until(() => fixture.notes.some((note) => note.type === 'task_cancel'));
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toHaveLength(1);
  });

  it('treats a working task as unusable once createdAt plus ttlMs has passed', async () => {
    const clock = createFakeClock(1_000_000);
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1, taskTtlMs: 5000, taskCreatedAt: new Date(1_000_000).toISOString() });
    const timers = observedTimers(clock);
    const { connection } = makeRemoteConnection({ fixture, timers, clock });
    await connection.listTools();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    clock.set(1_005_001);
    timers.advance(MIN_TASK_POLL_MS);
    const settled = await outcome;
    expect('error' in settled && settled.error).toBeInstanceOf(McpTaskError);
    expect('error' in settled && (settled.error as Error).message).toContain('ttl of 5000ms');
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toEqual([{ type: 'task_cancel', taskId }]);
  });

  it('measures the ttl on the server clock, so a local clock far ahead of the server does not fail a healthy task', async () => {
    const clock = createFakeClock(1_000_000);
    const serverCreatedAt = new Date(1_000_000 - 3_600_000).toISOString();
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1, taskTtlMs: 5000, taskCreatedAt: serverCreatedAt });
    const timers = observedTimers(clock);
    const { connection } = makeRemoteConnection({ fixture, timers, clock });
    await connection.listTools();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    fixture.completeTask(taskId, 'still healthy');
    timers.advance(MIN_TASK_POLL_MS);
    const settled = await outcome;
    expect('value' in settled && textOf(settled.value)).toBe('still healthy');
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toEqual([]);
  });

  it('uses the age the server reports through lastUpdatedAt when it already exceeds the ttl', async () => {
    const clock = createFakeClock(1_000_000);
    const fixture = await startHttpFixture({
      era: 'modern',
      taskPollIntervalMs: 1,
      taskTtlMs: 5000,
      taskCreatedAt: new Date(1_000_000).toISOString(),
      taskLastUpdatedAt: new Date(1_006_000).toISOString(),
    });
    const timers = observedTimers(clock);
    const { connection } = makeRemoteConnection({ fixture, timers, clock });
    await connection.listTools();
    const outcome = connection.callTool({ name: 'long_task', arguments: {}, timeoutMs: CALL_TIMEOUT_MS }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const settled = await outcome;
    expect('error' in settled && (settled.error as Error).message).toContain('ttl of 5000ms');
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toHaveLength(1);
  });

  it('does not fail a task with ttlMs 0 on the response that created it, and returns its result when the next poll finds it done', async () => {
    const clock = createFakeClock(1_000_000);
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1, taskTtlMs: 0, taskCreatedAt: new Date(1_000_000).toISOString() });
    const timers = observedTimers(clock);
    const { connection } = makeRemoteConnection({ fixture, timers, clock });
    await connection.listTools();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    fixture.completeTask(taskId, 'done at once');
    timers.advance(MIN_TASK_POLL_MS);
    const settled = await outcome;
    expect('value' in settled && textOf(settled.value)).toBe('done at once');
  });

  it('cancels and fails a task with ttlMs 0 that a later poll still finds working', async () => {
    const clock = createFakeClock(1_000_000);
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1, taskTtlMs: 0, taskCreatedAt: new Date(1_000_000).toISOString() });
    const timers = observedTimers(clock);
    const { connection } = makeRemoteConnection({ fixture, timers, clock });
    await connection.listTools();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    clock.set(1_000_001);
    timers.advance(MIN_TASK_POLL_MS);
    const settled = await outcome;
    expect('error' in settled && settled.error).toBeInstanceOf(McpTaskError);
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toEqual([{ type: 'task_cancel', taskId }]);
  });

  it('returns the result of a task that finished even when its ttl has passed', async () => {
    const clock = createFakeClock(1_000_000);
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1, taskTtlMs: 5000, taskCreatedAt: new Date(1_000_000).toISOString() });
    const timers = observedTimers(clock);
    const { connection } = makeRemoteConnection({ fixture, timers, clock });
    await connection.listTools();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    clock.set(1_100_000);
    fixture.completeTask(taskId, 'late but done');
    timers.advance(MIN_TASK_POLL_MS);
    const settled = await outcome;
    expect('value' in settled && textOf(settled.value)).toBe('late but done');
  });

  it('reports a failed task with its JSON-RPC error', async () => {
    const { fixture, timers, connection } = await setup();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    fixture.failTask(taskId, 'rate limited');
    timers.advance(MIN_TASK_POLL_MS);
    const settled = await outcome;
    expect('error' in settled && settled.error).toBeInstanceOf(McpTaskError);
    expect('error' in settled && (settled.error as Error).message).toContain('rate limited');
    expect('error' in settled && (settled.error as Error).message).toContain('-32603');
  });

  it('is not offered tasks by a 2025-11-25 server and gets the plain result', async () => {
    const { connection } = await setup('legacy');
    expect(textOf(await connection.callTool({ name: 'long_task', arguments: {} }))).toBe('tasks unsupported');
  });

  it('polls once a second when the server gives no interval hint', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: null });
    const timers = observedTimers(createFakeClock(1_000_000));
    const { connection } = makeRemoteConnection({ fixture, timers });
    await connection.listTools();
    const { outcome, taskId } = await startLongTask(fixture, timers, connection);
    expect(timers.pending().map((timer) => timer.delayMs)).toContain(DEFAULT_TASK_POLL_MS);
    fixture.completeTask(taskId, 'done');
    timers.advance(DEFAULT_TASK_POLL_MS);
    const settled = await outcome;
    expect('value' in settled && textOf(settled.value)).toBe('done');
  });

  it('records the task id as a checkpoint the moment the handle arrives', async () => {
    const { fixture, timers, connection } = await setup();
    const checkpoints: McpCheckpoint[] = [];
    const scheduled = timers.nextScheduled(isPoll);
    const outcome = connection.callTool({ name: 'long_task', arguments: {}, timeoutMs: CALL_TIMEOUT_MS, onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) });
    await scheduled;
    const [taskId] = fixture.taskIds();
    expect(checkpoints).toEqual([{ kind: 'task', taskId, answered: [] }]);
    fixture.completeTask(taskId as string, 'done');
    timers.advance(MIN_TASK_POLL_MS);
    await outcome;
  });

  it('resumes polling a recorded task on a fresh connection without starting a second one', async () => {
    const { fixture, timers, connection } = await setup();
    const checkpoints: McpCheckpoint[] = [];
    const scheduled = timers.nextScheduled(isPoll);
    const aborted = new AbortController();
    const first = connection.callTool({ name: 'long_task', arguments: {}, timeoutMs: CALL_TIMEOUT_MS, signal: aborted.signal, onCheckpoint: (checkpoint) => checkpoints.push(checkpoint) });
    first.catch(() => undefined);
    await scheduled;
    const taskId = fixture.taskIds()[0] as string;
    fixture.notes.length = 0;

    const restartedTimers = observedTimers(createFakeClock(1_000_000));
    const { connection: restarted } = makeRemoteConnection({ fixture, timers: restartedTimers });
    await restarted.listTools();
    fixture.completeTask(taskId, 'finished after restart');
    const result = await restarted.callTool({ name: 'long_task', arguments: {}, resume: { checkpoint: checkpoints[0] as McpCheckpoint, answers: {} } });
    expect(textOf(result)).toBe('finished after restart');
    expect(fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === 'long_task')).toHaveLength(1);
    expect(fixture.taskIds()).toEqual([taskId]);
    aborted.abort(new Error('first connection abandoned'));
  });

  it('hands a task that needs input back to the caller, then answers it with tasks/update', async () => {
    const { fixture, timers, connection } = await setup();
    const scheduled = timers.nextScheduled(isPoll);
    const outcome = connection.callTool({ name: 'ask_task', arguments: {}, timeoutMs: CALL_TIMEOUT_MS }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await scheduled;
    timers.advance(MIN_TASK_POLL_MS);
    const suspended = await outcome;
    const suspension = 'error' in suspended ? suspended.error : undefined;
    expect(suspension).toBeInstanceOf(McpInputSuspension);
    const { requests, checkpoint } = suspension as McpInputSuspension;
    const taskId = fixture.taskIds()[0] as string;
    expect(requests.map((request) => request.key)).toEqual(['name']);
    expect(checkpoint).toEqual({ kind: 'task', taskId, answered: [] });
    expect(fixture.rpcRecords('tasks/update')).toHaveLength(0);

    const resumedScheduled = timers.nextScheduled(isPoll);
    const resumed = connection.callTool({
      name: 'ask_task',
      arguments: {},
      timeoutMs: CALL_TIMEOUT_MS,
      resume: { checkpoint, answers: { name: { action: 'accept', content: { name: 'Ada' } } } },
    });
    await resumedScheduled;
    timers.advance(MIN_TASK_POLL_MS);
    expect(textOf(await resumed)).toBe('hello Ada');
    const [update] = fixture.rpcRecords('tasks/update');
    expect(update?.headers['mcp-name']).toBe(taskId);
    expect(update?.rpc?.params['inputResponses']).toEqual({ name: { action: 'accept', content: { name: 'Ada' } } });
    expect(fixture.rpcRecords('tasks/update')).toHaveLength(1);
    expect(fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === 'ask_task')).toHaveLength(1);
  });

  it('cancels a task that waits for input on the server when the caller gives it up', async () => {
    const { fixture, timers, connection } = await setup();
    const scheduled = timers.nextScheduled(isPoll);
    const outcome = connection.callTool({ name: 'ask_task', arguments: {}, timeoutMs: CALL_TIMEOUT_MS }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await scheduled;
    timers.advance(MIN_TASK_POLL_MS);
    const suspended = await outcome;
    const { checkpoint } = ('error' in suspended ? suspended.error : undefined) as McpInputSuspension;
    expect(checkpoint.kind).toBe('task');
    expect(fixture.rpcRecords('tasks/cancel')).toHaveLength(0);

    await connection.releaseCheckpoint(checkpoint);

    const taskId = fixture.taskIds()[0] as string;
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toEqual([{ type: 'task_cancel', taskId }]);
    expect(fixture.rpcRecords('tasks/cancel')).toHaveLength(1);
    expect(fixture.rpcRecords('tasks/cancel')[0]?.headers['mcp-name']).toBe(taskId);
  });
});
