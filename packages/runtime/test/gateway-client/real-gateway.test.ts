import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startGatewayProcess } from '@momonga/gateway';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createGatewayClient } from '../../src/gateway-client.ts';
import { CLIENT_VERSION, callOptions, collect, expectGatewayError, fakeClock, settle, streamBody, userInput } from './fixtures.ts';

const GATEWAY_VERSION = '1.10.0-test';
const REPLY_TEXT = 'Hello there';

type Context = {
  home: string;
  fake: FakeChatCompletionsServer;
  gateway: Awaited<ReturnType<typeof startGatewayProcess>>;
  client: ReturnType<typeof createGatewayClient>;
  restoreStdout: () => void;
};

let context: Context;

beforeAll(async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gh-'));
  fs.chmodSync(home, 0o700);
  const fake = await startFakeChatCompletions({
    scenario: 'tools-ok',
    script: [
      {
        kind: 'stream',
        chunks: [{ delta: { role: 'assistant', content: 'Hello' } }, { delta: { content: ' there' }, finishReason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ],
  });
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({
      models: {
        aliases: { default: ['primary'] },
        targets: {
          primary: { adapter: 'chat-completions', provider: 'fake', model: 'system', socketPath: fake.socketPath, capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } },
        },
      },
    }),
    { mode: 0o600 },
  );
  const gateway = await startGatewayProcess({ home, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home }, version: GATEWAY_VERSION });
  expect(Buffer.byteLength(gateway.socketPath)).toBeLessThan(104);
  const client = createGatewayClient({ socketPath: gateway.socketPath, clock: fakeClock(), version: CLIENT_VERSION });
  context = { home, fake, gateway, client, restoreStdout: () => stdout.mockRestore() };
});

afterAll(async () => {
  if (context === undefined) return;
  await context.client.destroy().catch(() => {});
  await context.gateway.close();
  await context.fake.close();
  context.restoreStdout();
  fs.rmSync(context.home, { recursive: true, force: true });
});

describe('gateway client against a real gateway', () => {
  it('streams the response events in order and the fake receives the user input', async () => {
    const clock = fakeClock();
    const events = await collect(context.client.stream(streamBody(), callOptions(clock, { idempotencyKey: 'real-stream-1' })));
    const types = events.map((event) => event.type);

    expect(types.slice(0, 2)).toEqual(['response.created', 'response.in_progress']);
    expect(types.at(-1)).toBe('response.completed');
    const text = events.flatMap((event) => (event.type === 'response.output_text.delta' ? [event.delta] : [])).join('');
    expect(text).toBe(REPLY_TEXT);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_event, index) => index));
  });

  it('lists the models with their capabilities', async () => {
    const models = await context.client.models();
    expect(models.map((model) => model.id)).toEqual(['default']);
    expect(models[0]?.capabilities).toMatchObject({ contextWindow: 4096, maxOutputTokens: 1024 });
    expect(Object.keys(models[0] ?? {}).sort()).toEqual(['capabilities', 'id', 'targetCapabilities']);
    expect(Object.keys(models[0]?.targetCapabilities ?? {})).toHaveLength(1);
  });

  it('looks up the capabilities of a target of the alias', async () => {
    const [target] = Object.keys((await context.client.models())[0]?.targetCapabilities ?? {});
    const capabilities = await context.client.capabilities('default', { signal: new AbortController().signal, target: String(target) });
    expect(capabilities).toMatchObject({ contextWindow: 4096, maxOutputTokens: 1024 });
  });

  it('looks up capabilities by alias', async () => {
    const capabilities = await context.client.capabilities('default', { signal: new AbortController().signal });
    expect(capabilities).toMatchObject({ contextWindow: 4096, maxOutputTokens: 1024 });
  });

  it('synthesises model_not_found for an alias the gateway does not list', async () => {
    const error = await settle(context.client.capabilities('missing', { signal: new AbortController().signal }));
    expectGatewayError(error, { status: 404, type: 'not_found', code: 'model_not_found' });
  });

  it('reports health', async () => {
    expect(await context.client.health()).toMatchObject({ version: GATEWAY_VERSION, apiVersion: 1, pid: process.pid, state: 'running' });
  });

  it('maps the gateway JSON error for an unknown model', async () => {
    const clock = fakeClock();
    const error = await settle(collect(context.client.stream({ model: 'nope', input: userInput('hi'), stream: true }, callOptions(clock, { idempotencyKey: 'real-stream-2' }))));
    expectGatewayError(error, { status: 404, type: 'not_found', code: 'model_not_found', param: 'model' });
  });

  it('answers false when cancelling a key the gateway does not know', async () => {
    expect(await context.client.cancel('never-sent', { signal: new AbortController().signal })).toBe(false);
  });
});
