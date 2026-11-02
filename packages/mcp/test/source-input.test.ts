import { describe, expect, it } from 'vitest';
import { createMcpToolSource } from '@momonga/mcp';
import { ToolInputRequired } from '@momonga/tools';
import type { AnyTool, ToolContext } from '@momonga/tools';
import { makeRemoteConnection, startHttpFixture, startOauthFixture } from './remote-harness.ts';

const ctxOf = (overrides: Partial<ToolContext>, checkpoints: Array<Record<string, unknown> | undefined> = []): ToolContext =>
  ({
    signal: new AbortController().signal,
    deadlineAt: 2_000_000,
    clock: { now: () => 1_000_000 },
    checkpoint: (state: Record<string, unknown> | undefined) => void checkpoints.push(state),
    ...overrides,
  }) as unknown as ToolContext;

const toolNamed = async (connection: ReturnType<typeof makeRemoteConnection>['connection'], name: string): Promise<AnyTool> => {
  const tools = await createMcpToolSource({ server: 'remote', connection }).list();
  const tool = tools.find((candidate) => candidate.name === `mcp__remote__${name}`);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
};

describe('MCP tools that need a person', () => {
  it('throws ToolInputRequired with the requests and a checkpoint, then completes from the checkpoint and the answers', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    const tool = await toolNamed(connection, 'mrtr_elicit');

    const suspension = await tool.execute({}, ctxOf({}), undefined).catch((error: unknown) => error);
    expect(suspension).toBeInstanceOf(ToolInputRequired);
    const { server, requests, checkpoint } = suspension as ToolInputRequired;
    expect(server).toBe('remote');
    expect(requests).toMatchObject([{ key: 'who', mode: 'form' }]);

    const checkpoints: Array<Record<string, unknown> | undefined> = [];
    const result = await tool.execute(
      {},
      ctxOf({ resume: { checkpoint, inputResponses: { who: { action: 'accept', content: { name: 'Ada' } } } } }, checkpoints),
      undefined,
    );
    expect(result).toMatchObject({ status: 'completed', output: 'hello Ada' });
    expect(checkpoints).toEqual([undefined]);
  });

  it('records the task id through ctx.checkpoint when the server returns a task handle', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const { connection } = makeRemoteConnection({ fixture });
    const tool = await toolNamed(connection, 'long_task');
    const checkpoints: Array<Record<string, unknown> | undefined> = [];
    const controller = new AbortController();
    const running = tool.execute({}, ctxOf({ signal: controller.signal }, checkpoints), undefined).catch(() => undefined);
    const taskId = await fixture.until(() => fixture.taskIds().length > 0).then(() => fixture.taskIds()[0]);
    await fixture.until(() => checkpoints.length > 0);
    expect(checkpoints).toEqual([{ kind: 'task', taskId, answered: [] }]);
    controller.abort(new Error('stop'));
    await running;
  });
});

describe('MCP tools that release a checkpoint', () => {
  it('cancels the recorded task on the server and leaves a client-held multi round-trip checkpoint alone', async () => {
    const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const { connection } = makeRemoteConnection({ fixture });
    const tool = await toolNamed(connection, 'ask_task');
    const signal = new AbortController().signal;

    await tool.releaseCheckpoint?.({ kind: 'mrtr', rounds: 1, requestState: 's' }, { signal });
    expect(fixture.rpcRecords('tasks/cancel')).toHaveLength(0);

    const checkpoints: Array<Record<string, unknown> | undefined> = [];
    const controller = new AbortController();
    const running = tool.execute({}, ctxOf({ signal: controller.signal }, checkpoints), undefined).catch(() => undefined);
    await fixture.until(() => checkpoints.length > 0);
    const [taskId] = fixture.taskIds();

    await tool.releaseCheckpoint?.(checkpoints[0] as Record<string, unknown>, { signal });

    expect(fixture.rpcRecords('tasks/cancel')).toHaveLength(1);
    expect(fixture.rpcRecords('tasks/cancel')[0]?.rpc?.params).toMatchObject({ taskId });
    controller.abort(new Error('stop'));
    await running;
  });
});

describe('MCP servers that need authorization', () => {
  it('lists no tools and names the server instead of failing the whole snapshot', async () => {
    const oauth = await startOauthFixture();
    const fixture = await startHttpFixture({ era: 'modern', oauth });
    const { connection } = makeRemoteConnection({ fixture });
    const listing = await createMcpToolSource({ server: 'remote', connection }).listWithNotices?.();
    expect(listing).toEqual({ tools: [], notices: [], authorizationRequired: ['remote'] });
  });
});
