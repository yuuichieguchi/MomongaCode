import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anthropicCountTokensReply,
  anthropicTextReply,
  anthropicToolUseReply,
  openResponsesTextReply,
  openResponsesToolCallReply,
  FAKE_ANTHROPIC_COUNT_TOKENS_PATH,
  startFakeAnthropic,
  startFakeOpenResponses,
} from '@momonga/testkit';
import type { FakeUpstreamReply, FakeUpstreamServer, RecordedUpstreamRequest } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { E2E_SECRETS_FILE_NAME } from './support/gateway-secrets-main.ts';
import { REPO_ROOT } from './support/launcher.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import type { RunEventFrame } from './support/runtime-client.ts';
import { DEFAULT_E2E_DEPS, startStack } from './support/stack.ts';
import { E2E_MARGIN_MS, E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const GATEWAY_SECRETS_MAIN = path.join(REPO_ROOT, 'e2e', 'support', 'gateway-secrets-main.ts');
const SECRET_NAME = 'provider-main';
const SECRET_VALUE = 'e2e-provider-key-7f3a91c2d4b6';
const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };
const PLAN_ARGUMENT_FRAGMENTS = ['{"entries": [{"content": "insp', 'ect the code", "status": "in_pro', 'gress", "priority": "high"}]}'];
const COUNTED_INPUT_TOKENS = 50;
const FINAL_TEXT = 'plan recorded, all done';

type Adapter = 'anthropic' | 'open-responses';

const startScriptedAnthropic = (socketPath: string, script: FakeUpstreamReply[]): Promise<FakeUpstreamServer> => {
  const remaining = [...script];
  return startFakeAnthropic({
    apiKey: SECRET_VALUE,
    socketPath,
    respond: (request) => (request.path === FAKE_ANTHROPIC_COUNT_TOKENS_PATH ? anthropicCountTokensReply(COUNTED_INPUT_TOKENS) : remaining.shift()),
  });
};

const writeSecrets = (home: E2eHome, secrets: Record<string, string>): void => {
  fs.writeFileSync(path.join(home.root, E2E_SECRETS_FILE_NAME), JSON.stringify(secrets), { mode: 0o600 });
};

const startProviderStack = async (home: E2eHome, adapter: Adapter, upstream: FakeUpstreamServer) => {
  const target = {
    adapter,
    model: 'upstream-model',
    socketPath: upstream.socketPath,
    apiKeySecret: SECRET_NAME,
    capabilities: CAPABILITIES,
    ...(adapter === 'open-responses' ? { provider: 'fake' } : {}),
  };
  return startStack({
    home,
    settings: { models: { aliases: { default: ['remote'] }, targets: { remote: target } } },
    deps: { ...DEFAULT_E2E_DEPS, launcherOverrides: { gateway: { script: GATEWAY_SECRETS_MAIN } } },
  });
};

const framesOf = async (runtime: ReturnType<typeof createRuntimeClient>, runId: string): Promise<RunEventFrame[]> => {
  const stream = runtime.events(runId);
  const frames = await stream.toEnd(E2E_MARGIN_MS);
  await stream.close();
  return frames;
};

const upstreamRequests = (upstream: FakeUpstreamServer): RecordedUpstreamRequest[] => upstream.requests.filter((request) => request.method === 'POST' && request.path !== FAKE_ANTHROPIC_COUNT_TOKENS_PATH);

const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [full] : [];
  });

const expectSecretAbsentFromMomongaHome = (home: E2eHome): void => {
  const leaking = filesUnder(path.join(home.home, '.momonga')).filter((file) => {
    try {
      return fs.readFileSync(file).toString('latin1').includes(SECRET_VALUE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENXIO') return false;
      throw error;
    }
  });
  expect(leaking).toEqual([]);
};

const expectCompletedToolRun = async (home: E2eHome, runtime: ReturnType<typeof createRuntimeClient>, runId: string): Promise<RunEventFrame[]> => {
  await until(async () => (await runtime.getRun(runId)).run.status === 'COMPLETED', {
    deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
    description: `run ${runId} is COMPLETED`,
  });
  const frames = await framesOf(runtime, runId);
  expect(framesOfType(frames, 'agent.message.delta').map((frame) => frame.data['text']).join('')).toBe(FINAL_TEXT);
  expect(framesOfType(frames, 'tool.completed')).toHaveLength(1);
  expect(framesOfType(frames, 'model.responded')).toHaveLength(2);
  expect(readDb<{ status: string }>(home.paths.databases.runtime, 'SELECT status FROM runs WHERE id = ?', runId)[0]?.status).toBe('COMPLETED');
  expectSecretAbsentFromMomongaHome(home);
  return frames;
};

describe('providers through real processes', () => {
  it(titleOf('providers-anthropic'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeSecrets(home, { [SECRET_NAME]: SECRET_VALUE });
    const upstream = await startScriptedAnthropic(path.join(home.root, 'a.sock'), [
      anthropicToolUseReply('toolu_e2e_1', 'UpdatePlan', PLAN_ARGUMENT_FRAGMENTS),
      anthropicTextReply(['plan recorded, ', 'all done']),
    ]);
    registerE2eCleanup(() => upstream.close());
    await startProviderStack(home, 'anthropic', upstream);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Record a plan');
      await expectCompletedToolRun(home, runtime, run.id);

      const requests = upstreamRequests(upstream);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.headers['x-api-key']).toBe(SECRET_VALUE);
        expect(request.headers['anthropic-version']).toBe('2023-06-01');
      }
      const [first, second] = requests.map((request) => request.body as { model: string; stream: boolean; max_tokens: number; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> });
      expect(first).toMatchObject({ model: 'upstream-model', stream: true, max_tokens: CAPABILITIES.maxOutputTokens });
      const assistant = second?.messages.find((message) => message.role === 'assistant');
      const toolUse = assistant?.content.find((block) => block['type'] === 'tool_use');
      expect(toolUse).toMatchObject({ name: 'UpdatePlan', input: { entries: [{ content: 'inspect the code', status: 'in_progress', priority: 'high' }] } });
      const toolResult = second?.messages.at(-1)?.content.find((block) => block['type'] === 'tool_result');
      expect(toolResult?.['tool_use_id']).toBe(toolUse?.['id']);
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('providers-open-responses'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeSecrets(home, { [SECRET_NAME]: SECRET_VALUE });
    const upstream = await startFakeOpenResponses({
      apiKey: SECRET_VALUE,
      socketPath: path.join(home.root, 'o.sock'),
      script: [openResponsesToolCallReply('call_e2e_1', 'UpdatePlan', PLAN_ARGUMENT_FRAGMENTS), openResponsesTextReply(['plan recorded, ', 'all done'])],
    });
    registerE2eCleanup(() => upstream.close());
    await startProviderStack(home, 'open-responses', upstream);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Record a plan');
      await expectCompletedToolRun(home, runtime, run.id);

      const requests = upstreamRequests(upstream);
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(request.headers['authorization']).toBe(`Bearer ${SECRET_VALUE}`);
      const [first, second] = requests.map((request) => request.body as { model: string; stream: boolean; store: boolean; input: Array<Record<string, unknown>> });
      expect(first).toMatchObject({ model: 'upstream-model', stream: true, store: false });
      const call = second?.input.find((item) => item['type'] === 'function_call');
      const output = second?.input.find((item) => item['type'] === 'function_call_output');
      expect(call).toMatchObject({ name: 'UpdatePlan' });
      expect(output?.['call_id']).toBe(call?.['call_id']);
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('providers-missing-secret'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeSecrets(home, {});
    const upstream = await startScriptedAnthropic(path.join(home.root, 'a.sock'), [anthropicTextReply(['unreachable'])]);
    registerE2eCleanup(() => upstream.close());
    await startProviderStack(home, 'anthropic', upstream);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Say hello');
      await until(async () => (await runtime.getRun(run.id)).run.status === 'FAILED', {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: `run ${run.id} is FAILED`,
      });
      expect(upstream.requests).toEqual([]);
      const failure = readDb<{ payload_json: string }>(
        home.paths.databases.runtime,
        "SELECT payload_json FROM events WHERE run_id = ? AND type = 'run.status' ORDER BY seq DESC LIMIT 1",
        run.id,
      )[0];
      expect(failure?.payload_json).toContain('secret_unavailable');
    } finally {
      await runtime.close();
    }
  });
  it(titleOf('providers-secret-added-after-start'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeSecrets(home, {});
    const upstream = await startScriptedAnthropic(path.join(home.root, 'a.sock'), [anthropicTextReply(['now it works'])]);
    registerE2eCleanup(() => upstream.close());
    await startProviderStack(home, 'anthropic', upstream);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const failed = await runtime.createRun(session.id, 'Say hello');
      await until(async () => (await runtime.getRun(failed.run.id)).run.status === 'FAILED', {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: `run ${failed.run.id} is FAILED`,
      });
      expect(upstream.requests).toEqual([]);
      writeSecrets(home, { [SECRET_NAME]: SECRET_VALUE });
      const { run } = await runtime.createRun(session.id, 'Say hello again');
      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: `run ${run.id} is COMPLETED`,
      });
      expect(upstreamRequests(upstream)).toHaveLength(1);
      expect(upstreamRequests(upstream)[0]?.headers['x-api-key']).toBe(SECRET_VALUE);
    } finally {
      await runtime.close();
    }
  });
});
