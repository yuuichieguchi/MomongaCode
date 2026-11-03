import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_MODERN_SERVER_PATH, MODERN_FIXTURE_RECORD_ENV, MODERN_FIXTURE_SETSID_GRANDCHILD_ENV } from '@momonga/testkit';
import type { ModernFixtureRecord } from '@momonga/testkit';
import { skipCase, titleOf } from './support/cases.ts';
import { GRANDCHILD_READY_FILE_NAME, MCP_RECORD_FILE_NAME, createE2eHome } from './support/home.ts';
import { isAlive } from './support/process.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { platformSandbox, sandboxOrSkip } from './support/sandbox.ts';
import { DEFAULT_E2E_DEPS, startStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { chatCompletions, messagesOf, precedingAssistantCallId, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RECOVERY_BOUND_MS, E2E_RESTART_POLICY, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const recordsOf = (file: string): ModernFixtureRecord[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ModernFixtureRecord);

const pidOfRecord = (records: readonly ModernFixtureRecord[], type: 'ready' | 'grandchild'): number[] =>
  records.flatMap((record) => (record.type === type ? [record.pid] : []));

describe('mcp: orphaned MCP server tree', () => {
  it.skipIf(skipCase('mcp-orphan'))(titleOf('mcp-orphan'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const recordFile = path.join(home.root, MCP_RECORD_FILE_NAME);
    const grandchildReady = path.join(home.root, GRANDCHILD_READY_FILE_NAME);
    const stack = await startStack({
      home,
      needsBash: true,
      deps: { ...DEFAULT_E2E_DEPS, restart: E2E_RESTART_POLICY },
      settings: {
        mcpServers: {
          fx: {
            command: process.execPath,
            args: [MCP_MODERN_SERVER_PATH],
            env: { [MODERN_FIXTURE_SETSID_GRANDCHILD_ENV]: grandchildReady, [MODERN_FIXTURE_RECORD_ENV]: recordFile },
          },
        },
      },
      script: [toolCallReply('mcp__fx__echo', { text: 'hi' }), textReply('done')],
    });
    expect(stack.sandbox).toBe(platformSandbox());
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Say hello');
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RECOVERY_BOUND_MS);
      await stream.close();
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');

      const calls = chatCompletions(stack.fake);
      expect(calls).toHaveLength(2);
      const toolMessage = messagesOf(calls[1]).at(-1);
      expect(toolMessage?.role).toBe('tool');
      const assistantCallId = precedingAssistantCallId(messagesOf(calls[1]), toolMessage);
      expect(assistantCallId).toMatch(/^call_[0-9a-f]{32}$/);
      expect(toolMessage?.tool_call_id).toBe(assistantCallId);
      expect(JSON.stringify(toolMessage?.content)).toContain('hi');

      const records = await until(
        () => {
          if (!fs.existsSync(recordFile) || !fs.existsSync(grandchildReady)) return undefined;
          const parsed = recordsOf(recordFile);
          return pidOfRecord(parsed, 'ready').length > 0 && pidOfRecord(parsed, 'grandchild').length > 0 ? parsed : undefined;
        },
        { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'MCP fixture ready and grandchild records' },
      );
      const serverPids = pidOfRecord(records, 'ready');
      expect(serverPids).toHaveLength(1);
      const serverPid = serverPids[0] as number;
      const grandchildPid = Number(fs.readFileSync(grandchildReady, 'utf8').trim());
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      expect(pidOfRecord(records, 'grandchild')).toEqual([grandchildPid]);
      await home.ledger.add(serverPid, 'mcp-record');
      await home.ledger.add(grandchildPid, 'mcp-record');

      expect(isAlive(serverPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);
      expect(fs.readdirSync(home.paths.markers.mcp).length).toBeGreaterThanOrEqual(1);

      const before = await stack.client.health();
      const oldRuntimePid = childOf(before, 'runtime').pid;
      const oldGatewayPid = childOf(before, 'gateway').pid;
      if (oldRuntimePid === undefined) throw new Error('runtime has no pid');
      expect(serverPid).not.toBe(oldRuntimePid);

      process.kill(oldRuntimePid, 'SIGKILL');

      const newRuntime = await stack.client.untilChild(
        'runtime',
        (child) => child.state === 'ready' && child.pid !== undefined && child.pid !== oldRuntimePid,
        E2E_RECOVERY_BOUND_MS,
      );
      expect(newRuntime.restarts).toBe(1);

      await until(() => !isAlive(serverPid) && !isAlive(grandchildPid) && fs.readdirSync(home.paths.markers.mcp).length === 0, {
        deadlineMs: E2E_RECOVERY_BOUND_MS,
        description: 'MCP server, setsid grandchild and MCP markers are gone',
      });

      const after = await stack.client.health();
      expect(childOf(after, 'gateway').pid).toBe(oldGatewayPid);
    } finally {
      await runtime.close();
    }
  });
});
