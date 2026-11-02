import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { DEFAULT_TASK_POLL_MS, McpTaskError, MIN_TASK_POLL_MS } from '@momonga/mcp';

const CALL_TIMEOUT_MS = 1_000_000;
const isPoll = (ms: number): boolean => ms !== CALL_TIMEOUT_MS;
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
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toHaveLength(1);
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
});
