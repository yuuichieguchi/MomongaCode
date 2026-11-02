import { describe, expect, it } from 'vitest';
import { MRTR_STATE_ONLY_PACING_MS, McpInputProtocolError, McpInputSuspension } from '@momonga/mcp';
import type { McpTimers } from '@momonga/mcp';
import { makeRemoteConnection, startHttpFixture, textOf } from './remote-harness.ts';

const INJECTED_ROUNDS = 2;

const instantTimers = (): McpTimers & { delays: number[] } => {
  const delays: number[] = [];
  return {
    delays,
    setTimeout: (callback, ms) => {
      if (ms !== MRTR_STATE_ONLY_PACING_MS) return undefined;
      delays.push(ms);
      queueMicrotask(callback);
      return undefined;
    },
    clearTimeout: () => undefined,
  };
};

const toolCalls = (fixture: Awaited<ReturnType<typeof startHttpFixture>>, tool: string) =>
  fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === tool);

describe('multi round-trip requests', () => {
  it('retries with the byte-exact requestState on a fresh request id until the result completes', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const timers = instantTimers();
    const { connection } = makeRemoteConnection({ fixture, timers });
    await connection.listTools();
    expect(textOf(await connection.callTool({ name: 'mrtr_state', arguments: {} }))).toBe('mrtr complete');
    expect(timers.delays).toEqual([MRTR_STATE_ONLY_PACING_MS, MRTR_STATE_ONLY_PACING_MS]);

    const calls = toolCalls(fixture, 'mrtr_state');
    expect(calls.map((record) => record.rpc?.params['requestState'])).toEqual([undefined, 'round-1', 'round-2']);
    expect(new Set(calls.map((record) => record.rpc?.id)).size).toBe(3);
    expect(calls.every((record) => record.rpc?.params['inputResponses'] === undefined)).toBe(true);
  });

  it('stops a server that never completes after the round cap', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture, timers: instantTimers(), connection: { mrtrMaxRounds: INJECTED_ROUNDS } });
    await connection.listTools();
    const failure = await connection.callTool({ name: 'mrtr_loop', arguments: {} }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(failure?.code).toBe('INPUT_REQUIRED_ROUNDS_EXCEEDED');
    expect(toolCalls(fixture, 'mrtr_loop')).toHaveLength(INJECTED_ROUNDS + 1);
  });

  it('declares form and url elicitation in the per-request capabilities', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const suspension = await connection.callTool({ name: 'mrtr_elicit', arguments: {} }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(suspension).toBeInstanceOf(McpInputSuspension);
    const meta = toolCalls(fixture, 'mrtr_elicit')[0]?.rpc?.params['_meta'] as Record<string, Record<string, unknown>>;
    const capabilities = meta['io.modelcontextprotocol/clientCapabilities'] as Record<string, unknown>;
    expect(capabilities['elicitation']).toEqual({ form: {}, url: {} });
  });

  it('hands a form elicitation back to the caller without answering it', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const suspension = (await connection.callTool({ name: 'mrtr_elicit', arguments: {} }).catch((error: unknown) => error)) as McpInputSuspension;
    expect(suspension.requests).toEqual([
      {
        key: 'who',
        mode: 'form',
        message: 'Who are you?',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    ]);
    expect(suspension.checkpoint).toEqual({ kind: 'mrtr', rounds: 1, requestState: 'ask' });
    expect(toolCalls(fixture, 'mrtr_elicit')).toHaveLength(1);
  });

  it('resumes the round with the answer and the byte-exact requestState on a fresh id', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const suspension = (await connection.callTool({ name: 'mrtr_elicit', arguments: {} }).catch((error: unknown) => error)) as McpInputSuspension;
    const result = await connection.callTool({
      name: 'mrtr_elicit',
      arguments: {},
      resume: { checkpoint: suspension.checkpoint, answers: { who: { action: 'accept', content: { name: 'Ada' } } } },
    });
    expect(textOf(result)).toBe('hello Ada');
    const calls = toolCalls(fixture, 'mrtr_elicit');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.rpc?.params['requestState']).toBe('ask');
    expect(calls[1]?.rpc?.params['inputResponses']).toEqual({ who: { action: 'accept', content: { name: 'Ada' } } });
    expect(calls[1]?.rpc?.id).not.toBe(calls[0]?.rpc?.id);
  });

  it('hands a url elicitation back with the url intact and relays a decline unchanged', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const suspension = (await connection.callTool({ name: 'mrtr_url', arguments: {} }).catch((error: unknown) => error)) as McpInputSuspension;
    expect(suspension.requests).toEqual([{ key: 'link', mode: 'url', message: 'Connect your account.', url: 'https://example.test/connect?s=1' }]);
    const result = await connection.callTool({
      name: 'mrtr_url',
      arguments: {},
      resume: { checkpoint: suspension.checkpoint, answers: { link: { action: 'decline' } } },
    });
    expect(textOf(result)).toBe('link decline');
  });

  it('fails with a typed error when a server asks for input the client never declared', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const failure = await connection.callTool({ name: 'mrtr_sampling', arguments: {} }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(McpInputProtocolError);
    expect((failure as Error).message).toContain('sampling/createMessage');
    expect(toolCalls(fixture, 'mrtr_sampling')).toHaveLength(1);
  });
});
