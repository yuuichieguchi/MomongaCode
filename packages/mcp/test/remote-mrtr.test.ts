import { describe, expect, it } from 'vitest';
const INJECTED_ROUNDS = 2;
import { makeRemoteConnection, startHttpFixture, textOf } from './remote-harness.ts';

const toolCalls = (fixture: Awaited<ReturnType<typeof startHttpFixture>>, tool: string) =>
  fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === tool);

describe('multi round-trip requests', () => {
  it('retries with the byte-exact requestState on a fresh request id until the result completes', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    expect(textOf(await connection.callTool({ name: 'mrtr_state', arguments: {} }))).toBe('mrtr complete');

    const calls = toolCalls(fixture, 'mrtr_state');
    expect(calls.map((record) => record.rpc?.params['requestState'])).toEqual([undefined, 'round-1', 'round-2']);
    expect(new Set(calls.map((record) => record.rpc?.id)).size).toBe(3);
    expect(calls.every((record) => record.rpc?.params['inputResponses'] === undefined)).toBe(true);
  });

  it('stops a server that never completes after the round cap', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture, connection: { mrtrMaxRounds: INJECTED_ROUNDS } });
    await connection.listTools();
    const failure = await connection.callTool({ name: 'mrtr_loop', arguments: {} }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(failure?.code).toBe('INPUT_REQUIRED_ROUNDS_EXCEEDED');
    expect(toolCalls(fixture, 'mrtr_loop')).toHaveLength(INJECTED_ROUNDS + 1);
  });

  it('declares no elicitation support, so a conforming server asks for nothing', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    expect(textOf(await connection.callTool({ name: 'mrtr_elicit', arguments: {} }))).toBe('elicitation unavailable');
    const meta = toolCalls(fixture, 'mrtr_elicit')[0]?.rpc?.params['_meta'] as Record<string, Record<string, unknown>>;
    const capabilities = meta['io.modelcontextprotocol/clientCapabilities'] as Record<string, unknown>;
    expect(Object.keys(capabilities)).toEqual(['extensions']);
  });

  it('fails with a typed error when a server asks for input it was never offered', async () => {
    const fixture = await startHttpFixture({ era: 'modern', sendInputRequestsWithoutCapability: true });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    const failure = await connection.callTool({ name: 'mrtr_elicit', arguments: {} }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(failure?.code).toBe('CAPABILITY_NOT_SUPPORTED');
    expect(failure?.message).toContain("no handler is registered for 'elicitation/create'");
    expect(toolCalls(fixture, 'mrtr_elicit')).toHaveLength(1);
  });
});
