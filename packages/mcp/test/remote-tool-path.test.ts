import { describe, expect, it } from 'vitest';
import { createMcpToolSource } from '@momonga/mcp';
import { createToolRegistry } from '@momonga/tools';
import { makeExecutor } from './mcp-harness.ts';
import { makeRemoteConnection, startHttpFixture } from './remote-harness.ts';

const SMALL_TOOL_TIMEOUT_MS = 300;

const setup = async (era: 'modern' | 'legacy' = 'modern', requestTimeoutMs?: number) => {
  const fixture = await startHttpFixture({ era });
  const { connection } = makeRemoteConnection({ fixture });
  const registry = createToolRegistry();
  registry.addSource(createMcpToolSource({ server: 'remote', connection, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) }));
  const harness = makeExecutor();
  const toolSet = await registry.snapshot();
  return { fixture, connection, harness, toolSet };
};

const callsOf = (fixture: Awaited<ReturnType<typeof startHttpFixture>>, tool: string) =>
  fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === tool);

describe.each(['modern', 'legacy'] as const)('a remote tool through the executor (%s server)', (era) => {
  it('lists the server tools under the mcp__<server>__ prefix and runs one', async () => {
    const { toolSet, harness } = await setup(era);
    expect(toolSet.get('mcp__remote__echo')?.name).toBe('mcp__remote__echo');
    const result = await harness.resultOf(toolSet, 'mcp__remote__echo', { text: 'hello' });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('hello');
  });

  it('rejects invalid arguments with the shared validation before any request is sent', async () => {
    const { toolSet, harness, fixture } = await setup(era);
    const result = await harness.resultOf(toolSet, 'mcp__remote__echo', { text: 42 });
    expect(result.status).toBe('failed');
    expect(callsOf(fixture, 'echo')).toHaveLength(0);
  });

  it('honours a deny rule before any request is sent', async () => {
    const { toolSet, harness, fixture } = await setup(era);
    const result = await harness.resultOf(toolSet, 'mcp__remote__echo', { text: 'x' }, { rules: [harness.rule('deny', 'mcp__remote__echo')] });
    expect(result.status).toBe('failed');
    expect(callsOf(fixture, 'echo')).toHaveLength(0);
  });

  it('asks for approval like any other tool when no rule allows it', async () => {
    const { toolSet, harness, fixture } = await setup(era);
    const outcome = await harness.run(toolSet, 'mcp__remote__echo', { text: 'x' }, { rules: [] });
    expect(outcome?.kind).toBe('needs_approval');
    expect(callsOf(fixture, 'echo')).toHaveLength(0);
  });

  it('aborts a slow call at the tool timeout and closes its stream or cancels it', async () => {
    const { toolSet, harness, fixture } = await setup(era, SMALL_TOOL_TIMEOUT_MS);
    const result = await harness.resultOf(toolSet, 'mcp__remote__slow', {});
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/timed out/i);
    await fixture.until(() => fixture.notes.some((note) => note.type === (era === 'modern' ? 'aborted' : 'cancelled')));
  });
});

describe('a task through the executor', () => {
  it('outlives the tool timeout and finishes when the server completes it', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const { connection } = makeRemoteConnection({ fixture });
    const registry = createToolRegistry();
    registry.addSource(createMcpToolSource({ server: 'remote', connection, requestTimeoutMs: 20 }));
    const toolSet = await registry.snapshot();
    const running = makeExecutor().resultOf(toolSet, 'mcp__remote__long_task', {});
    await fixture.until(() => fixture.rpcRecords('tasks/get').length >= 2);
    const [taskId] = fixture.taskIds();
    fixture.completeTask(taskId as string, 'done after the tool timeout');
    const result = await running;
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done after the tool timeout');
    expect(fixture.notes.filter((note) => note.type === 'task_cancel')).toEqual([]);
  });
});

describe('transient failures', () => {
  it('retries a read-only remote tool once its stream was cut, and runs it a second time', async () => {
    const { toolSet, harness, fixture } = await setup('modern');
    const result = await harness.resultOf(toolSet, 'mcp__remote__flaky_read', {});
    expect(result.status).toBe('completed');
    expect(result.output).toBe('flaky ok after 2 calls');
    expect(callsOf(fixture, 'flaky_read')).toHaveLength(2);
  });

  it('never re-runs a write tool whose stream was cut', async () => {
    const { toolSet, harness, fixture } = await setup('modern');
    const result = await harness.resultOf(toolSet, 'mcp__remote__stream_drop', {});
    expect(result.status).toBe('failed');
    expect(callsOf(fixture, 'stream_drop')).toHaveLength(1);
  });
});
