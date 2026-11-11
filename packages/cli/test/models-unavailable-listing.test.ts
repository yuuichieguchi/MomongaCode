import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { fixedSocket } from '@momonga/foundation';
import type { MomongaModelEntry, MomongaModelList } from '@momonga/protocol';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import type { GatewayClient, PlanGatewayClient } from '../src/client/gateway-client.ts';
import { authStatus } from '../src/commands/auth.ts';
import { formatModels, modelsDocumentOf } from '../src/commands/models.ts';
import { BUILTIN_SLASH_COMMANDS } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import { CHATGPT } from './fake-plan-gateway.tsx';
import { serveModelsListing } from './fake-models-listing.ts';

const M =
  'the model plan-model cannot be used yet: the settings give no context window and output limit for it, and the model list of its account reports none; momonga models --catalog reads the list';
const PROBING_MESSAGE = 'measuring this model (once per model and OS build)';

const UNAV = { toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: M, param: 'model' }, source: 'unprobed' };
const PROBING = { toolCalling: { state: 'probing', message: PROBING_MESSAGE, retryAfterSeconds: 5 }, source: 'unprobed' };
const LOCAL = {
  contextWindow: 32768,
  maxOutputTokens: 8192,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 4,
  source: 'probed',
};

const member = (model: string, upstream: string, billing: string, capabilities: unknown) => ({ model, counter: '1'.repeat(64), billing, adapter: 'chat-completions', answers: 'model', upstream, capabilities });

const PLAN_MODEL = 'chatgpt/plan-model';
const LOCAL_MODEL = 'lmstudio/local-model';
const SLOW_MODEL = 'apple/slow';

const LISTING = [
  { id: PLAN_MODEL, object: 'model', provider: 'chatgpt', ownName: 'plan-model', billing: 'plan', capabilities: UNAV, chain: [member(PLAN_MODEL, 'plan-model', 'plan', UNAV), member(LOCAL_MODEL, 'local-model', 'local', LOCAL)] },
  { id: LOCAL_MODEL, object: 'model', provider: 'lmstudio', ownName: 'local-model', billing: 'local', capabilities: LOCAL, chain: [member(LOCAL_MODEL, 'local-model', 'local', LOCAL)] },
  { id: SLOW_MODEL, object: 'model', provider: 'apple', ownName: 'slow', billing: 'local', capabilities: PROBING, chain: [member(SLOW_MODEL, 'slow', 'local', PROBING)] },
];

const ENTRIES = LISTING as unknown as readonly MomongaModelEntry[];

const LISTED: MomongaModelList = { object: 'list', data: [...ENTRIES], start: null, roles: {} };

const serveListing = async (context: TestContext): Promise<GatewayClient> => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const body = JSON.stringify({ object: 'list', data: LISTING, start: null, roles: {} });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath) });
  registerCleanup(context, async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return client;
};

describe('the CLI shows a model that is not listed with capabilities by its state (G1)', () => {
  it('isModelList accepts an unavailable entry', async (context) => {
    const client = await serveListing(context);
    const models = await client.models();
    expect(models.map((model) => model.id)).toEqual([PLAN_MODEL, LOCAL_MODEL, SLOW_MODEL]);
    expect(models[0]?.capabilities).toEqual(UNAV);
  });

  it('refuses a listing whose chain member holds malformed capabilities, as it refuses malformed capabilities of the entry', async (context) => {
    const malformed = { ...LOCAL, contextWindow: 'wide' };
    const answerTo = async (entry: Record<string, unknown>): Promise<{ refusal: string | undefined; expected: string }> => {
      const data = [entry];
      const gateway = await serveModelsListing(context, data);
      const client = createGatewayClient({ resolveSocket: fixedSocket(gateway.socketPath) });
      registerCleanup(context, () => client.close());
      const refusal = await client.models().then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      return { refusal, expected: 'GET /v1/momonga/models answered a body that is not a model list' };
    };
    const base = { id: LOCAL_MODEL, object: 'model', provider: 'lmstudio', ownName: 'local-model', billing: 'local' };
    const entryLevel = await answerTo({ ...base, capabilities: malformed, chain: [member(LOCAL_MODEL, 'local-model', 'local', LOCAL)] });
    expect(entryLevel.refusal).toBe(entryLevel.expected);
    const memberLevel = await answerTo({ ...base, capabilities: LOCAL, chain: [member(LOCAL_MODEL, 'local-model', 'local', malformed)] });
    expect(memberLevel.refusal).toBe(memberLevel.expected);
  });

  it('momonga models prints a plan model with its billing, a listed one with its window and a measured one without a window', () => {
    expect(formatModels(modelsDocumentOf(LISTED, new Map([['lmstudio', 'http://127.0.0.1:1234/v1']]), new Set()))).toBe(
      ['chatgpt', '  plan-model  ·  plan', 'lmstudio  ·  http://127.0.0.1:1234/v1', '  local-model  ·  32.8k tokens  ·  local', 'apple', '  slow  ·  window not known'].join('\n'),
    );
  });

  it('momonga models --json names the state of each model, with the code and the message of an unavailable one', () => {
    expect(modelsDocumentOf(LISTED, new Map(), new Set()).models.map(({ model, state, code, message }) => ({ model, state, code, message }))).toEqual([
      { model: PLAN_MODEL, state: 'unavailable', code: 'capabilities_unknown', message: M },
      { model: LOCAL_MODEL, state: 'ready', code: undefined, message: undefined },
      { model: SLOW_MODEL, state: 'probing', code: undefined, message: undefined },
    ]);
  });

  it('/model prints the reason in the row', async () => {
    const shown: string[] = [];
    const context = { model: LOCAL_MODEL, backend: { models: async () => ENTRIES }, info: (text: string) => void shown.push(text) } as unknown as SlashContext;
    const command = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === 'model');
    await command?.run('', context);
    expect(shown).toEqual(
      [
        [
          'models (the current one is marked *):',
          `    plan-model  ${M}`,
          '  * local-model  32768-token window',
          `    slow  ${PROBING_MESSAGE}`,
          'switch with /model <model>; a change applies from the next task',
        ].join('\n'),
      ],
    );
  });

  it('contextWindowOf rejects with the reason text', async (context) => {
    const client = await serveListing(context);
    await expect(client.contextWindowOf(PLAN_MODEL)).rejects.toThrow(new Error(M));
  });

  it('auth status prints the model line of an unavailable model', async () => {
    const written: string[] = [];
    const plan = { accounts: async () => ({ profiles: [CHATGPT], accounts: [] }) } as unknown as PlanGatewayClient;
    expect(await authStatus({ stdout: { write: (text: string) => void written.push(text) }, plan, listing: async () => LISTED }, { json: false, model: 'plan-model' })).toBe(0);
    expect(written.join('').split('\n')).toContain('model: plan-model (plan)');
  });
});
