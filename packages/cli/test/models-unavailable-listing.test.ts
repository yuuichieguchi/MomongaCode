import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { fixedSocket } from '@momonga/foundation';
import type { MomongaModelEntry } from '@momonga/protocol';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import type { GatewayClient, PlanGatewayClient } from '../src/client/gateway-client.ts';
import { authStatus } from '../src/commands/auth.ts';
import { formatModels } from '../src/commands/models.ts';
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

const LISTING = [
  { id: 'plan-alias', object: 'model', targets: ['plan-gpt'], capabilities: UNAV, targetCapabilities: { 'plan-gpt': UNAV }, targetBilling: { 'plan-gpt': 'plan' } },
  { id: 'mixed', object: 'model', targets: ['plan-gpt', 'local'], capabilities: UNAV, targetCapabilities: { 'plan-gpt': UNAV, local: LOCAL }, targetBilling: { 'plan-gpt': 'plan', local: 'metered' } },
  { id: 'local-alias', object: 'model', targets: ['local'], capabilities: LOCAL, targetCapabilities: { local: LOCAL }, targetBilling: { local: 'metered' } },
  { id: 'probing-alias', object: 'model', targets: ['slow'], capabilities: PROBING, targetCapabilities: { slow: PROBING }, targetBilling: { slow: 'metered' } },
];

const ENTRIES = LISTING as unknown as readonly MomongaModelEntry[];

const serveListing = async (context: TestContext): Promise<GatewayClient> => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const body = JSON.stringify({ object: 'list', data: LISTING });
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

describe('the CLI shows an alias that is not listed with capabilities by its reason (G1)', () => {
  it('isModelList accepts an unavailable entry', async (context) => {
    const client = await serveListing(context);
    const models = await client.models();
    expect(models.map((model) => model.id)).toEqual(['plan-alias', 'mixed', 'local-alias', 'probing-alias']);
    expect(models[0]?.capabilities).toEqual(UNAV);
  });

  it('refuses a listing whose targetCapabilities holds a malformed value, as it refuses a malformed alias capabilities', async (context) => {
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
      return { refusal, expected: `GET /v1/momonga/models answered a body that is not a model list: ${JSON.stringify({ object: 'list', data })}` };
    };
    const base = { id: 'local-alias', object: 'model', targets: ['local'], targetBilling: { local: 'metered' } };
    const aliasLevel = await answerTo({ ...base, capabilities: malformed, targetCapabilities: { local: LOCAL } });
    expect(aliasLevel.refusal).toBe(aliasLevel.expected);
    const targetLevel = await answerTo({ ...base, capabilities: LOCAL, targetCapabilities: { local: malformed } });
    expect(targetLevel.refusal).toBe(targetLevel.expected);
  });

  it('momonga models prints the reason line for a not-listed alias and the block for a listed one', () => {
    expect(formatModels(ENTRIES)).toBe(
      [
        'plan-alias  -> plan-gpt',
        `    ${M}`,
        'mixed  -> plan-gpt, local',
        `    ${M}`,
        'local-alias  -> local',
        '    context window: 32768, max output: 8192',
        '    tool calling: native, parallel tool calls: unknown, structured output: json_schema',
        '    JSON-only mode: not measured',
        '    image input: no, streaming: yes, stop sequences: yes',
        '    token counting: estimated, usage reported: yes, max concurrency: 4',
        '    schema dialect: json-schema-2020-12, source: probed',
        'probing-alias  -> slow',
        `    ${PROBING_MESSAGE}`,
      ].join('\n'),
    );
  });

  it('/model prints the reason in the row', async () => {
    const shown: string[] = [];
    const context = { modelAlias: 'local-alias', backend: { models: async () => ENTRIES }, info: (text: string) => void shown.push(text) } as unknown as SlashContext;
    const command = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === 'model');
    await command?.run('', context);
    expect(shown).toEqual(
      [
        [
          'models (the current one is marked *):',
          `    plan-alias  ${M}`,
          `    mixed  ${M}`,
          '  * local-alias  32768-token window',
          `    probing-alias  ${PROBING_MESSAGE}`,
          'switch with /model <alias>; a change applies from the next task',
        ].join('\n'),
      ],
    );
  });

  it('contextWindowOf rejects with the reason text', async (context) => {
    const client = await serveListing(context);
    await expect(client.contextWindowOf('plan-alias')).rejects.toThrow(new Error(M));
  });

  it('auth status prints the model line of an unavailable alias', async () => {
    const written: string[] = [];
    const plan = { accounts: async () => ({ profiles: [CHATGPT], accounts: [] }) } as unknown as PlanGatewayClient;
    expect(await authStatus({ stdout: { write: (text: string) => void written.push(text) }, plan, models: async () => ENTRIES }, { json: false, alias: 'plan-alias' })).toBe(0);
    expect(written.join('').split('\n')).toContain('model: plan-alias -> plan-gpt (plan)');
  });
});
