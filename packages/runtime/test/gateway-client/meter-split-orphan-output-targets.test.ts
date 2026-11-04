import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenMeter } from '@momonga/context';
import { momongaPaths } from '@momonga/foundation';
import { probeOllamaTarget, startGatewayProcess } from '@momonga/gateway';
import type { CountTokensRequest, CountTokensResult, FunctionTool, InputItem } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startFakeChatCompletions } from '@momonga/testkit';
import { createGatewayClient } from '../../src/gateway-client.ts';
import { OLLAMA_MODEL, startFakeOllama } from '../../../gateway/test/ollama-support.ts';
import { CLIENT_VERSION, fakeClock } from './fixtures.ts';

const ALIAS = 'default';
const CONTEXT_WINDOW = 12288;

const READ_TOOL: FunctionTool = {
  type: 'function',
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  strict: true,
};

const closers: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const makeHome = (): string => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gm-'));
  fs.chmodSync(home, 0o700);
  closers.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};

const writeTarget = (home: string, target: Record<string, unknown>): void => {
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ models: { aliases: { [ALIAS]: ['primary'] }, targets: { primary: target } } }), { mode: 0o600 });
};

const launch = async (home: string) => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  closers.push(() => stdout.mockRestore());
  const gateway = await startGatewayProcess({ home, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home }, version: '1.10.0-test' });
  closers.push(() => gateway.close());
  const client = createGatewayClient({ socketPath: gateway.socketPath, clock: fakeClock(), version: CLIENT_VERSION });
  closers.push(() => client.destroy().catch(() => {}));
  return client;
};

const chatCompletionsClient = async (toolCalling: 'native' | 'constrained') => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', script: [] });
  closers.push(() => fake.close());
  const home = makeHome();
  writeTarget(home, {
    adapter: 'chat-completions',
    provider: 'fake',
    model: 'system',
    socketPath: fake.socketPath,
    toolCalling,
    capabilities: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: 1024 },
  });
  return launch(home);
};

const ollamaClient = async () => {
  const fake = await startFakeOllama({});
  const home = makeHome();
  writeTarget(home, { adapter: 'ollama', model: OLLAMA_MODEL, baseUrl: fake.origin, capabilities: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: 1024 } });
  await probeOllamaTarget({
    probeRecordDir: momongaPaths(home, process.platform, {}).probe,
    upstream: { kind: 'tcp', baseUrl: fake.origin },
    model: OLLAMA_MODEL,
    contextWindow: CONTEXT_WINDOW,
  });
  return launch(home);
};

type Client = Awaited<ReturnType<typeof launch>>;
type Rejection = { input: unknown; lenient: unknown; code: unknown; message: unknown };

const userItem = (text: string): InputItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const readCall: InputItem = { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' };
const outputOf = (text: string): InputItem => ({ type: 'function_call_output', call_id: 'c1', output: text });
const REPORTED = [userItem('please read a.txt'), readCall, outputOf('alpha '.repeat(40))];
const EVICTED = [userItem('please read a.txt'), readCall, outputOf('[tool output omitted: 60 tokens; stored as h1; read it with ReadOutput]')];

const splitCountOf = async (client: Client, tools: FunctionTool[]) => {
  const rejections: Rejection[] = [];
  const signal = new AbortController().signal;
  const counter = {
    count: async (request: CountTokensRequest): Promise<CountTokensResult> => {
      try {
        return await client.countTokens(request, { signal });
      } catch (error) {
        const fields = error as { code?: unknown; message?: unknown };
        rejections.push({ input: request.input, lenient: request.momonga?.lenient_items, code: fields.code, message: fields.message });
        throw error;
      }
    },
  };
  const capabilities = await client.capabilities(ALIAS, { signal });
  const meter = createTokenMeter({ counter, model: ALIAS, capabilities });
  const first = await meter.count({ input: REPORTED, tools });
  meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens });
  const outcome = await meter.count({ input: EVICTED, tools }).then(
    (view) => ({ counted: view.inputTokens > 0 }),
    (error: unknown) => ({ failed: String(error) }),
  );
  return { capabilities, rejections, outcome };
};

describe('the token meter split on an output rewritten in place, per target kind', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('counts it on an ollama target, whose count estimates the input without rendering the history', async () => {
    const { rejections, outcome } = await splitCountOf(await ollamaClient(), [READ_TOOL]);
    expect(rejections).toEqual([]);
    expect(outcome).toEqual({ counted: true });
  });

  it('counts it on a native chat-completions target when the root has no tools', async () => {
    const { capabilities, rejections, outcome } = await splitCountOf(await chatCompletionsClient('native'), []);
    expect(capabilities.toolCalling).toBe('native');
    expect(rejections).toEqual([]);
    expect(outcome).toEqual({ counted: true });
  });

  it('counts it on a native chat-completions target with tools, whose history does not check call ids', async () => {
    const { capabilities, rejections, outcome } = await splitCountOf(await chatCompletionsClient('native'), [READ_TOOL]);
    expect(capabilities.toolCalling).toBe('native');
    expect(rejections).toEqual([]);
    expect(outcome).toEqual({ counted: true });
  });
});
