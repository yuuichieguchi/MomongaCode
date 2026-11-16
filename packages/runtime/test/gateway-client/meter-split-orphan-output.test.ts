import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenMeter } from '@momonga/context';
import { startGatewayProcess } from '@momonga/gateway';
import type { CountTokensRequest, CountTokensResult, FunctionTool, InputItem } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, modelSettings, startFakeChatCompletions, registerOwned, createTempDir, removeTempDir, testLocks } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createGatewayClient } from '../../src/gateway-client.ts';
import { CLIENT_VERSION, fakeClock } from './fixtures.ts';
import { FIRST_GENERATION, fixedSocket } from '@momonga/foundation';
import { prepareGatewayHome } from './prepared-home.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MODEL = 'fake/system';

const READ_TOOL: FunctionTool = {
  type: 'function',
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  strict: true,
};

type Context = {
  home: string;
  fake: FakeChatCompletionsServer;
  gateway: Awaited<ReturnType<typeof startGatewayProcess>>;
  client: ReturnType<typeof createGatewayClient>;
  restoreStdout: () => void;
};

let context: Context;
let suiteHome: string | undefined;
let closeGateway: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  const home = createTempDir({ asHome: true });
  suiteHome = home;
  const fake = await startFakeChatCompletions({ scenario: 'json-schema-only', script: [] });
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify(
      modelSettings({ models: [{ provider: 'fake', id: 'system', socketPath: fake.socketPath, toolCalling: 'constrained', capabilities: { contextWindow: 32768, maxOutputTokens: 1024 } }] }),
    ),
    { mode: 0o600 },
  );
  await prepareGatewayHome(home);
  const gateway = await registerOwned(
    (cleanup) => {
      closeGateway = cleanup;
    },
    () => startGatewayProcess({ platform: process.platform, locks: testLocks(), generation: FIRST_GENERATION, home, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home }, version: '1.10.0-test' }),
  );
  const client = createGatewayClient({ resolveSocket: fixedSocket(gateway.socketPath), clock: fakeClock(), version: CLIENT_VERSION });
  context = { home, fake, gateway, client, restoreStdout: () => stdout.mockRestore() };
});

afterAll(async () => {
  await context?.client.destroy().catch(() => {});
  await closeGateway();
  await context?.fake.close();
  context?.restoreStdout();
  if (suiteHome !== undefined) await removeTempDir(suiteHome);
});

const userItem = (text: string): InputItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const readCall: InputItem = { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' };
const outputOf = (text: string): InputItem => ({ type: 'function_call_output', call_id: 'c1', output: text });

type Rejection = { input: unknown; lenient: unknown; code: unknown; message: unknown };

const recordingMeter = async () => {
  const rejections: Rejection[] = [];
  const signal = new AbortController().signal;
  const counter = {
    count: async (request: CountTokensRequest): Promise<CountTokensResult> => {
      try {
        return await context.client.countTokens(request, { signal });
      } catch (error) {
        const fields = error as { code?: unknown; message?: unknown };
        rejections.push({ input: request.input, lenient: request.momonga?.lenient_items, code: fields.code, message: fields.message });
        throw error;
      }
    },
  };
  const capabilities = await context.client.capabilities(MODEL, { signal });
  expect(capabilities.toolCalling).toBe('constrained');
  return { meter: createTokenMeter({ counter, model: MODEL, capabilities }), rejections };
};

describe('the token meter split against a constrained chat-completions gateway', () => {
  it('counts an input whose prefix shared with the latest report ends between a function_call and its evicted output', async () => {
    const { meter, rejections } = await recordingMeter();
    const tools = [READ_TOOL];
    const reported = [userItem('please read a.txt'), readCall, outputOf('alpha '.repeat(40))];
    const evicted = [userItem('please read a.txt'), readCall, outputOf('[tool output omitted: 600 tokens; stored as h1; read it with ReadOutput]')];

    const first = await meter.count({ input: reported, tools });
    meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens });

    const outcome = await meter.count({ input: evicted, tools }).then(
      (view) => ({ counted: view.inputTokens > 0 }),
      (error: unknown) => ({ failed: String(error) }),
    );

    expect(rejections).toEqual([]);
    expect(outcome).toEqual({ counted: true });
  });
});
