import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createJsonLogger, systemClock } from '@momonga/foundation';
import type { FakeScriptedReply } from '@momonga/testkit';
import { captureStream, launchRuntime, modelSettings, prepareStack, readDb, runStatus, startGateway, waitForCondition, waitForStatus } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const TEST_API_KEY = 'momonga-test-api-key';
const TEST_API_KEY_ENV = 'MOMONGA_TEST_KEY';
const REDACTED = '[REDACTED]';
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'];

const expectNoCredential = (text: string, key: string): void => {
  const windows = Array.from({ length: key.length - 7 }, (_, index) => key.slice(index, index + 8));
  expect(windows.filter((window) => text.includes(window)), `credential windows leaked into: ${text.slice(0, 300)}`).toEqual([]);
};

const ECHO_401: FakeScriptedReply = {
  kind: 'error',
  status: 401,
  body: { error: { message: `Incorrect API key provided: ${TEST_API_KEY}`, type: 'invalid_request_error', param: null, code: 'invalid_api_key' } },
};

const FINISH_REASON_ECHO: FakeScriptedReply = {
  kind: 'stream',
  chunks: [{ delta: { role: 'assistant', content: 'partial' } }, { delta: {}, finishReason: TEST_API_KEY }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const keyedModels = (fakeSocketPath: string): Record<string, unknown> => {
  const base = modelSettings(fakeSocketPath) as { models: { aliases: unknown; targets: { primary: Record<string, unknown> } } };
  return { models: { ...base.models, targets: { primary: { ...base.models.targets.primary, apiKeyEnv: TEST_API_KEY_ENV } } } };
};

const journalOf = (temp: RunHome, runId: string): string =>
  JSON.stringify(readDb<{ type: string; payload_json: string }>(temp.paths.databases.runtime, 'SELECT type, payload_json FROM events WHERE run_id = ? ORDER BY seq', runId));

const noticesOf = (temp: RunHome, runId: string): string[] =>
  readDb<{ payload_json: string }>(temp.paths.databases.runtime, "SELECT payload_json FROM events WHERE run_id = ? AND type = 'notice' ORDER BY seq", runId).map(
    (row) => (JSON.parse(row.payload_json) as { message: string }).message,
  );

const startKeyedRun = async (reply: FakeScriptedReply) => {
  const stack = await prepareStack({ routes: [{ match: () => true, reply }] });
  stack.settings(keyedModels(stack.fake.socketPath));
  const gatewayLog = captureStream();
  await startGateway(stack.temp, {
    env: { [TEST_API_KEY_ENV]: TEST_API_KEY },
    logger: createJsonLogger({ service: 'gateway', clock: systemClock, stream: gatewayLog, level: 'debug' }),
  });
  const launched = await launchRuntime(stack.temp);
  const session = await launched.createSession();
  const run = await launched.createRun(session.id, { input: 'Say hello' });
  return { stack, launched, gatewayLog, runId: run.id as string };
};

describe('T7: a credential echoed by the upstream stays out of the runtime journal', () => {
  it('fails the run with authentication_failed and a redacted error, and keeps the journal and the gateway log clean', PROCESS_TIMEOUT, async () => {
    const { stack, launched, gatewayLog, runId } = await startKeyedRun(ECHO_401);
    expect(await waitForStatus(stack.temp, runId, TERMINAL)).toBe('FAILED');
    const view = (await launched.http('GET', `/v1/runs/${runId}`)).json.run;
    expect(view.error.code).toBe('authentication_failed');
    expect(view.error.message).toContain(REDACTED);
    expectNoCredential(JSON.stringify(view), TEST_API_KEY);
    const journal = journalOf(stack.temp, runId);
    expectNoCredential(journal, TEST_API_KEY);
    expectNoCredential(gatewayLog.chunks.join(''), TEST_API_KEY);
    expectNoCredential(launched.stdout.chunks.join(''), TEST_API_KEY);
  });

  it('keeps the retry notice clean when the finish_reason echoes the key', PROCESS_TIMEOUT, async () => {
    const { stack, gatewayLog, runId } = await startKeyedRun(FINISH_REASON_ECHO);
    await waitForCondition(() => {
      const status = runStatus(stack.temp, runId);
      return noticesOf(stack.temp, runId).length > 0 || (status !== undefined && TERMINAL.includes(status));
    }, `a notice or a terminal state for run ${runId}`);
    const notices = noticesOf(stack.temp, runId);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.some((notice) => notice.includes(REDACTED))).toBe(true);
    for (const notice of notices) expectNoCredential(notice, TEST_API_KEY);
    expectNoCredential(journalOf(stack.temp, runId), TEST_API_KEY);
    expectNoCredential(gatewayLog.chunks.join(''), TEST_API_KEY);
  });
});
