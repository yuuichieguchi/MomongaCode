import { describe, expect, it } from 'vitest';
import { McpInputSuspension, McpParkedInputLostError, connectMcpServer, createMcpToolSource } from '@momonga/mcp';
import type { McpServerConnection } from '@momonga/mcp';
import { FIXTURE_EXTRA_TOOLS_ENV, MCP_LEGACY_SERVER_PATH, createFakeClock } from '@momonga/testkit';
import { ToolInputRequired } from '@momonga/tools';
import type { AnyTool, ToolContext } from '@momonga/tools';
import { BASE_ENV, makeDir, onCleanup } from './mcp-harness.ts';

const connect = async (): Promise<McpServerConnection> => {
  const connection = await connectMcpServer({
    name: 'legacy',
    config: { command: process.execPath, args: [MCP_LEGACY_SERVER_PATH], env: { [FIXTURE_EXTRA_TOOLS_ENV]: 'ask_name' } },
    scope: 'user',
    projectDir: makeDir(),
    baseEnv: BASE_ENV,
    clock: createFakeClock(1_000_000),
  });
  onCleanup(() => connection.close());
  return connection;
};

const textOf = (result: { content?: unknown }): string =>
  (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

const suspensionOf = async (connection: McpServerConnection, signal?: AbortSignal): Promise<McpInputSuspension> => {
  const outcome = await connection.callTool({ name: 'ask_name', arguments: {}, ...(signal === undefined ? {} : { signal }) }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if (!('error' in outcome) || !(outcome.error instanceof McpInputSuspension)) throw new Error('expected the call to hand its request for input back');
  return outcome.error;
};

describe('server-initiated elicitation from a 2025-11-25 server', () => {
  it('hands the request back as an input request and finishes the same open call with the answer', async () => {
    const connection = await connect();
    expect(connection.protocolEra).toBe('legacy');

    const suspension = await suspensionOf(connection);

    expect(suspension.requests).toEqual([
      { key: 'elicitation', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    ]);
    expect(suspension.checkpoint.kind).toBe('parked');
    const result = await connection.callTool({
      name: 'ask_name',
      arguments: {},
      resume: { checkpoint: suspension.checkpoint, answers: { elicitation: { action: 'accept', content: { name: 'Ada' } } } },
    });
    expect(textOf(result)).toBe('hello Ada');
  });

  it('passes a decline to the server', async () => {
    const connection = await connect();
    const suspension = await suspensionOf(connection);

    const result = await connection.callTool({
      name: 'ask_name',
      arguments: {},
      resume: { checkpoint: suspension.checkpoint, answers: { elicitation: { action: 'decline' } } },
    });

    expect(textOf(result)).toBe('elicitation decline');
  });

  it('keeps the call alive across the suspension even though the caller signal ended with the first attempt', async () => {
    const connection = await connect();
    const first = new AbortController();
    const suspension = await suspensionOf(connection, first.signal);
    first.abort(new Error('the first attempt ended'));

    const result = await connection.callTool({
      name: 'ask_name',
      arguments: {},
      resume: { checkpoint: suspension.checkpoint, answers: { elicitation: { action: 'accept', content: { name: 'Grace' } } } },
    });

    expect(textOf(result)).toBe('hello Grace');
  });

  it('answers the server with cancel and drops the open call when the checkpoint is released', async () => {
    const connection = await connect();
    const suspension = await suspensionOf(connection);

    await connection.releaseCheckpoint(suspension.checkpoint);

    const failure = await connection
      .callTool({ name: 'ask_name', arguments: {}, resume: { checkpoint: suspension.checkpoint, answers: { elicitation: { action: 'accept', content: { name: 'Ada' } } } } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpParkedInputLostError);
  });

  it('cannot resume a request that a previous connection held', async () => {
    const first = await connect();
    const suspension = await suspensionOf(first);
    const second = await connect();

    const failure = await second
      .callTool({ name: 'ask_name', arguments: {}, resume: { checkpoint: suspension.checkpoint, answers: { elicitation: { action: 'accept', content: { name: 'Ada' } } } } })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpParkedInputLostError);
  });

  it('closes cleanly while a request is parked', async () => {
    const connection = await connect();
    await suspensionOf(connection);

    await expect(connection.close()).resolves.toBeUndefined();
  });

  it('reaches the person through the tool source as ToolInputRequired and completes the call on resume', async () => {
    const connection = await connect();
    const tools = await createMcpToolSource({ server: 'legacy', connection }).list();
    const tool = tools.find((candidate): candidate is AnyTool => candidate.name === 'mcp__legacy__ask_name');
    if (tool === undefined) throw new Error('the ask_name tool is missing');
    const checkpoints: Array<Record<string, unknown> | undefined> = [];
    const context = (extra: Partial<ToolContext>): ToolContext =>
      ({
        signal: new AbortController().signal,
        deadlineAt: 2_000_000,
        clock: { now: () => 1_000_000 },
        checkpoint: (state: Record<string, unknown> | undefined) => void checkpoints.push(state),
        ...extra,
      }) as unknown as ToolContext;

    const suspension = await tool.execute({}, context({}), undefined).catch((error: unknown) => error);
    expect(suspension).toBeInstanceOf(ToolInputRequired);
    const { server, requests, checkpoint } = suspension as ToolInputRequired;
    expect(server).toBe('legacy');
    expect(requests).toMatchObject([{ key: 'elicitation', mode: 'form' }]);
    expect(checkpoint['kind']).toBe('parked');

    const result = await tool.execute(
      {},
      context({ resume: { checkpoint, inputResponses: { elicitation: { action: 'accept', content: { name: 'Ada' } } } } }),
      undefined,
    );
    expect(result).toMatchObject({ status: 'completed', output: 'hello Ada' });
    expect(checkpoints).toEqual([undefined]);
  });
});
