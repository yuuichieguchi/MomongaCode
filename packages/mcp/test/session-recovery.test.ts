import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { MIN_TASK_POLL_MS, McpInputSuspension, McpParkedInputLostError, McpTaskError } from '@momonga/mcp';
import { makeRemoteConnection, observedTimers, startHttpFixture, textOf } from './remote-harness.ts';

const CALL_TIMEOUT_MS = 1_000_000;

const callsOf = (fixture: Awaited<ReturnType<typeof startHttpFixture>>, tool: string) =>
  fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === tool);

describe('a session that expires after a tool call created a task', () => {
  it('continues the task by its id on a new session instead of calling the tool again', async () => {
    const fixture = await startHttpFixture({ era: 'legacy', legacyTasks: true, taskPollIntervalMs: 1 });
    const timers = observedTimers(createFakeClock(1_000_000));
    const { connection } = makeRemoteConnection({ fixture, timers });
    await connection.listTools();
    const polled = timers.nextScheduled((ms) => ms === MIN_TASK_POLL_MS);
    const outcome = connection.callTool({ name: 'long_task', arguments: {}, timeoutMs: CALL_TIMEOUT_MS });
    await polled;
    const [taskId] = fixture.taskIds();

    fixture.expireSessions();
    fixture.completeTask(taskId as string, 'finished on the new session');
    timers.advance(MIN_TASK_POLL_MS);

    expect(textOf(await outcome)).toBe('finished on the new session');
    expect(callsOf(fixture, 'long_task')).toHaveLength(1);
    expect(fixture.taskIds()).toEqual([taskId]);
    expect(fixture.rpcRecords('initialize').map((record) => record.status)).toEqual([200, 200]);
  });
});

describe('a task past its ttl whose tasks/cancel meets an expired session', () => {
  it('fails with the ttl error and does not discard the session or rerun the call', async () => {
    const fixture = await startHttpFixture({
      era: 'legacy',
      legacyTasks: true,
      taskPollIntervalMs: 1,
      taskTtlMs: 5000,
      taskCreatedAt: new Date(1_000_000).toISOString(),
      taskLastUpdatedAt: new Date(1_006_000).toISOString(),
      expireSessionOnTaskCancel: true,
    });
    const { connection } = makeRemoteConnection({ fixture, timers: observedTimers(createFakeClock(1_000_000)) });
    await connection.listTools();

    const failure = await connection.callTool({ name: 'long_task', arguments: {}, timeoutMs: CALL_TIMEOUT_MS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpTaskError);
    expect((failure as McpTaskError).message).toContain('ttl of 5000ms');
    expect((failure as McpTaskError).cancelFailure).toBeDefined();
    expect((failure as McpTaskError).cause).toBeUndefined();
    expect(callsOf(fixture, 'long_task')).toHaveLength(1);
    expect(fixture.rpcRecords('tasks/cancel')).toHaveLength(1);
    expect(fixture.rpcRecords('initialize')).toHaveLength(1);
  });
});

describe('a session that expires while a call waits for the person', () => {
  it('loses the parked call with a typed error once the connection discards the dead session', async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const first = await connection.callTool({ name: 'ask_name', arguments: {} }).catch((error: unknown) => error);
    if (!(first instanceof McpInputSuspension)) throw first;
    expect(first.checkpoint.kind).toBe('parked');

    fixture.expireSessions();
    await connection.listTools();

    const failure = await connection
      .callTool({
        name: 'ask_name',
        arguments: {},
        resume: { checkpoint: first.checkpoint, answers: { elicitation: { action: 'accept', content: { name: 'Ada' } } } },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpParkedInputLostError);
  });
});
