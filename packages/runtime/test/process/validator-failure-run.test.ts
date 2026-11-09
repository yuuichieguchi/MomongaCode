import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS, ENGINE_FAILURE_MESSAGE, FIXTURE_EXTRA_TOOLS_ENV, MCP_MODERN_SERVER_PATH, fakeUsageOfRequest } from '@momonga/testkit';
import { launchRuntime, modelSettings, prepareStack, readDb, scriptedToolCall, startGateway, waitForCondition } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

vi.mock('../../../foundation/src/untrusted-engine.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../foundation/src/untrusted-engine.ts')>();
  const { injectEngineFailure } = await import('../../../testkit/src/engine-failure.ts');
  return { ...original, ataEngine: injectEngineFailure(original.ataEngine) };
});

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const WINDOW_HOLDING_EVERY_TOOL = 65_536;
const THROWING = 'mcp__fx__validator_throws';
const ENGINE_MESSAGE = ENGINE_FAILURE_MESSAGE;
const MCP_SETTINGS = { mcpServers: { fx: { command: process.execPath, args: [MCP_MODERN_SERVER_PATH], env: { [FIXTURE_EXTRA_TOOLS_ENV]: 'validator_throws' } } } };

const finalAnswer = {
  kind: 'stream' as const,
  chunks: [{ delta: { role: 'assistant', content: 'The tool was unavailable.' }, finishReason: 'stop' }],
  usage: (body: unknown) => fakeUsageOfRequest(body, 5),
};

const payloadsOf = (temp: RunHome, runId: string, type: string): any[] =>
  readDb<{ payload_json: string }>(temp.paths.databases.runtime, 'SELECT payload_json FROM events WHERE run_id = ? AND type = ? ORDER BY seq', runId, type).map((row) => JSON.parse(row.payload_json));

const runRow = (temp: RunHome, runId: string): { status: string; attempts: number } | undefined =>
  readDb<{ status: string; attempts: number }>(temp.paths.databases.runtime, 'SELECT status, attempts FROM runs WHERE id = ?', runId)[0];

const settledOrRetried = async (temp: RunHome, runId: string): Promise<{ status: string; attempts: number } | undefined> => {
  await waitForCondition(() => {
    const row = runRow(temp, runId);
    return row !== undefined && (['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_HUMAN'].includes(row.status) || row.attempts > 1);
  }, `run ${runId} to settle or be retried`);
  return runRow(temp, runId);
};

const offeredToolNames = (body: any): string[] => (Array.isArray(body?.tools) ? body.tools.map((tool: any) => tool?.function?.name ?? tool?.name) : []);

describe('a run whose MCP tool validator throws while validating (system timers, in-process gateway)', () => {
  it('answers both calls with the unavailable tool error, keeps the offered tool set and completes on its first attempt', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack({ script: [scriptedToolCall(THROWING, {}, 'call_1'), scriptedToolCall(THROWING, {}, 'call_2'), finalAnswer], contextWindow: WINDOW_HOLDING_EVERY_TOOL });
    stack.settings({ ...modelSettings(stack.fake.socketPath, WINDOW_HOLDING_EVERY_TOOL), ...MCP_SETTINGS });
    await startGateway(stack.temp);
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession({ permissionMode: 'bypassPermissions', bypassAllowed: true });
    const run = await launched.createRun(session.id, { input: 'Use the tool twice' });

    expect(await settledOrRetried(stack.temp, run.id)).toEqual({ status: 'COMPLETED', attempts: 1 });

    const completed = payloadsOf(stack.temp, run.id, 'tool.completed');
    expect(completed).toHaveLength(2);
    for (const result of completed) {
      expect(result.status).toBe('failed');
      expect(result.output).toMatch(/unavailable/i);
      expect(result.output).toContain(THROWING);
    }
    expect(payloadsOf(stack.temp, run.id, 'tool.started')).toEqual([]);

    const notices = payloadsOf(stack.temp, run.id, 'notice').filter((notice) => String(notice.message).includes(THROWING));
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain('fx');
    expect(notices[0].message).toContain(ENGINE_MESSAGE);

    const started = payloadsOf(stack.temp, run.id, 'run.started');
    expect(started).toHaveLength(1);
    const requested = payloadsOf(stack.temp, run.id, 'model.requested');
    expect(requested).toHaveLength(3);
    const toolLists = requested.map((event) => offeredToolNames(event.body));
    expect(toolLists[0]).toContain(THROWING);
    expect(toolLists[1]).toEqual(toolLists[0]);
    expect(toolLists[2]).toEqual(toolLists[0]);
    for (const event of requested.slice(1)) expect(event.prefix?.toolsChanged ?? false).toBe(false);
    expect(payloadsOf(stack.temp, run.id, 'notice').filter((notice) => notice.code === 'tools_changed')).toEqual([]);
  });
});
