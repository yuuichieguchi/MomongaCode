import { describe, expect, it, vi } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, ENGINE_FAILURE_MESSAGE, FIXTURE_EXTRA_TOOLS_ENV, MCP_MODERN_SERVER_PATH, fakeUsageOfRequest } from '@momonga/testkit';
import { launchRuntime, readDb, scriptedToolCall, startStack, waitForCondition } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

vi.mock('../../../foundation/src/untrusted-engine.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../foundation/src/untrusted-engine.ts')>();
  const { injectEngineFailure } = await import('../../../testkit/src/engine-failure.ts');
  return { ...original, ataEngine: injectEngineFailure(original.ataEngine) };
});

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const THROWING = 'mcp__fx__validator_throws';
const ENGINE_MESSAGE = ENGINE_FAILURE_MESSAGE;
const MCP_SETTINGS = { mcpServers: { fx: { command: process.execPath, args: [MCP_MODERN_SERVER_PATH], env: { [FIXTURE_EXTRA_TOOLS_ENV]: 'validator_throws' } } } };

const answer = (text: string) => ({
  kind: 'stream' as const,
  chunks: [{ delta: { role: 'assistant', content: text }, finishReason: 'stop' }],
  usage: (body: unknown) => fakeUsageOfRequest(body, 5),
});

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

describe('the run after a validate-time validator failure in the same daemon (system timers, in-process gateway)', () => {
  it('does not offer the tool and records a registration notice, as a compile failure does', PROCESS_TIMEOUT, async () => {
    const stack = await startStack({ script: [scriptedToolCall(THROWING, {}, 'call_1'), answer('first done'), answer('second done')] }, MCP_SETTINGS);
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession({ permissionMode: 'bypassPermissions', bypassAllowed: true });
    const first = await launched.createRun(session.id, { input: 'Use the tool' });
    expect(await settledOrRetried(stack.temp, first.id)).toEqual({ status: 'COMPLETED', attempts: 1 });

    const second = await launched.createRun(session.id, { input: 'Answer without tools' });
    expect(await settledOrRetried(stack.temp, second.id)).toEqual({ status: 'COMPLETED', attempts: 1 });

    const requested = payloadsOf(stack.temp, second.id, 'model.requested');
    expect(requested.length).toBeGreaterThan(0);
    for (const event of requested) expect(offeredToolNames(event.body)).not.toContain(THROWING);
    const skipped = payloadsOf(stack.temp, second.id, 'notice').filter((notice) => String(notice.message).includes(THROWING));
    expect(skipped).toHaveLength(1);
    expect(skipped[0].message).toContain('skipped');
    expect(skipped[0].message).toContain(ENGINE_MESSAGE);
  });
});
