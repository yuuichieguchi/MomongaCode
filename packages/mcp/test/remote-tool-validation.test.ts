import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { MIN_TASK_POLL_MS } from '@momonga/mcp';
import { NEVER_ABORTED } from './mcp-harness.ts';
import { makeRemoteConnection, observedTimers, startHttpFixture, textOf } from './remote-harness.ts';

const INVALID_HEADER_TOOLS = ['bad_header_number', 'bad_header_empty', 'bad_header_token', 'bad_header_duplicate', 'bad_header_anyof', 'bad_header_array'];

const failureOf = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => error as Error,
  );

describe('structured output validation', () => {
  it('accepts a direct result that matches the outputSchema', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    expect(textOf(await connection.callTool({ name: 'structured', arguments: { valid: true }, signal: NEVER_ABORTED }))).toBe('structured');
  });

  it('rejects a direct result that breaks the outputSchema', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const failure = await failureOf(connection.callTool({ name: 'structured', arguments: { valid: false }, signal: NEVER_ABORTED }));
    expect(failure.message).toContain("Structured content does not match the tool's output schema");
  });

  it('applies the same validation to the result of a completed task', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const timers = observedTimers(createFakeClock(1_000_000));
    const { connection } = makeRemoteConnection({ fixture, timers });
    await connection.listTools();
    const scheduled = timers.nextScheduled((ms) => ms === MIN_TASK_POLL_MS);
    const outcome = failureOf(connection.callTool({ name: 'structured_task', arguments: {}, signal: NEVER_ABORTED, timeoutMs: 1_000_000 }));
    await scheduled;
    fixture.completeTask(fixture.taskIds()[0] as string, 'task result', { n: 'not a number' });
    timers.advance(MIN_TASK_POLL_MS);
    expect((await outcome).message).toContain("Structured content does not match the tool's output schema");
  });

  it('accepts a completed task whose result matches the outputSchema', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const timers = observedTimers(createFakeClock(1_000_000));
    const { connection } = makeRemoteConnection({ fixture, timers });
    await connection.listTools();
    const scheduled = timers.nextScheduled((ms) => ms === MIN_TASK_POLL_MS);
    const outcome = connection.callTool({ name: 'structured_task', arguments: {}, signal: NEVER_ABORTED, timeoutMs: 1_000_000 });
    await scheduled;
    fixture.completeTask(fixture.taskIds()[0] as string, 'task result', { n: 2 });
    timers.advance(MIN_TASK_POLL_MS);
    expect(textOf(await outcome)).toBe('task result');
  });

  it('rejects a completed task that omits the structured content its outputSchema promises', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const timers = observedTimers(createFakeClock(1_000_000));
    const { connection } = makeRemoteConnection({ fixture, timers });
    await connection.listTools();
    const scheduled = timers.nextScheduled((ms) => ms === MIN_TASK_POLL_MS);
    const outcome = failureOf(connection.callTool({ name: 'structured_task', arguments: {}, signal: NEVER_ABORTED, timeoutMs: 1_000_000 }));
    await scheduled;
    fixture.completeTask(fixture.taskIds()[0] as string, 'no structure');
    timers.advance(MIN_TASK_POLL_MS);
    expect((await outcome).message).toContain('did not return structured content');
  });
});

describe('SEP-2243 x-mcp-header annotations', () => {
  it('excludes every tool whose annotations break the constraints and keeps the valid ones', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    const names = (await connection.listTools()).map((tool) => tool.name);
    for (const invalid of INVALID_HEADER_TOOLS) expect(names, invalid).not.toContain(invalid);
    expect(names).toContain('region_echo');
    expect(names).toContain('echo');
  });

  it('mirrors the annotation of a valid tool into an Mcp-Param header', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    expect(textOf(await connection.callTool({ name: 'region_echo', arguments: { region: 'eu' }, signal: NEVER_ABORTED }))).toBe('region eu');
    const call = fixture.rpcRecords('tools/call').find((record) => record.rpc?.params['name'] === 'region_echo');
    expect(call?.headers['mcp-param-region']).toBe('eu');
  });

  it('does not exclude them on a 2025-11-25 server, which has no header mirroring', async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const { connection } = makeRemoteConnection({ fixture });
    const names = (await connection.listTools()).map((tool) => tool.name);
    for (const tool of INVALID_HEADER_TOOLS) expect(names).toContain(tool);
  });
});
