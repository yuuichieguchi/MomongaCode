import { describe, expect, it } from 'vitest';
import { startMcpHttpFixture } from '@momonga/testkit';
import type { McpHttpFixtureEra } from '@momonga/testkit';
import { skipCase, titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { startStack } from './support/stack.ts';
import { chatCompletions, messagesOf, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const runWithRemoteServer = async (era: McpHttpFixtureEra, script: ReturnType<typeof toolCallReply>[]) => {
  const fixture = await startMcpHttpFixture({ era });
  const home = await createE2eHome();
  const stack = await startStack({
    home,
    settings: { mcpServers: { remote: { type: 'http', url: fixture.url } } },
    script: [...script, textReply('done')],
  });
  const runtime = createRuntimeClient(home);
  try {
    const { session } = await runtime.createSession();
    const { run } = await runtime.createRun(session.id, 'Use the remote tool');
    const stream = runtime.events(run.id);
    const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
    await stream.close();
    return { fixture, stack, frames };
  } finally {
    await runtime.close();
  }
};

const toolMessages = (stack: Awaited<ReturnType<typeof runWithRemoteServer>>['stack']): string[] => {
  const calls = chatCompletions(stack.fake);
  return messagesOf(calls.at(-1))
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.stringify(message.content));
};

describe('mcp: remote servers', () => {
  it.skipIf(skipCase('mcp-remote-modern'))(titleOf('mcp-remote-modern'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { fixture, stack, frames } = await runWithRemoteServer('modern', [
      toolCallReply('mcp__remote__echo', { text: 'hi from the model' }, 'call_1'),
      toolCallReply('mcp__remote__mrtr_state', {}, 'call_2'),
    ]);
    try {
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');
      const messages = toolMessages(stack);
      expect(messages.some((message) => message.includes('hi from the model'))).toBe(true);
      expect(messages.some((message) => message.includes('mrtr complete'))).toBe(true);

      const echo = fixture.rpcRecords('tools/call').find((record) => record.rpc?.params['name'] === 'echo');
      expect(echo?.headers['mcp-method']).toBe('tools/call');
      expect(echo?.headers['mcp-name']).toBe('echo');
      expect(echo?.headers['mcp-protocol-version']).toBe('2026-07-28');
      expect(echo?.headers['mcp-session-id']).toBeUndefined();
      const rounds = fixture.rpcRecords('tools/call').filter((record) => record.rpc?.params['name'] === 'mrtr_state');
      expect(rounds.map((record) => record.rpc?.params['requestState'])).toEqual([undefined, 'round-1', 'round-2']);
    } finally {
      await fixture.close();
    }
  });

  it.skipIf(skipCase('mcp-remote-legacy'))(titleOf('mcp-remote-legacy'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { fixture, stack, frames } = await runWithRemoteServer('legacy', [toolCallReply('mcp__remote__echo', { text: 'hi legacy' }, 'call_1')]);
    try {
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');
      expect(toolMessages(stack).some((message) => message.includes('hi legacy'))).toBe(true);
      const echo = fixture.rpcRecords('tools/call')[0];
      expect(echo?.headers['mcp-session-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(fixture.rpcRecords('initialize')).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
});
