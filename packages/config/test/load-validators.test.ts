import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import * as protocol from '@momonga/protocol';
import { CAPABILITIES, S1, S2, S4, chatConnection, ollamaConnection } from './model-fixtures.ts';
import { loadFile, refusalOf } from './load-models.ts';

const exported = <T>(module: object, name: string, home: string): T => {
  const value = (module as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`${home} does not export ${name}`);
  return value as T;
};

const PRICE = { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 3, outputPerMTok: 15, currency: 'USD' };

const anthropic = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ adapter: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', ...extra, models: [{ id: 'claude-x', capabilities: CAPABILITIES }] });

const ANTHROPIC_ADDRESS = 'https://api.anthropic.com';

const refusedAt = async (document: unknown, pointer: string, reason: RegExp): Promise<void> => {
  const { file, message } = await refusalOf(document);
  const head = `${file}: invalid settings at ${pointer}: `;
  expect(message.slice(0, head.length)).toBe(head);
  expect(message.slice(head.length)).toMatch(reason);
};

const chatWithCeiling = (maxOutputTokens: number): Record<string, unknown> => ({ ...chatConnection('http://127.0.0.1:8080/v1'), models: [{ id: 'm', capabilities: { contextWindow: 8192, maxOutputTokens } }] });

const withServer = (name: string, server: unknown): unknown => ({ mcpServers: { [name]: server } });

describe('a value a consumer refuses is refused when the settings file loads, with file, pointer and reason', () => {
  it('a network connection with neither baseUrl nor socketPath', async () => {
    await refusedAt({ models: { connections: [anthropic()] } }, '/models/connections/0', /exactly one of baseUrl and socketPath/);
    await refusedAt({ models: { connections: [ollamaConnection(ANTHROPIC_ADDRESS), { adapter: 'chat-completions', models: [{ id: 'm', capabilities: CAPABILITIES }] }] } }, '/models/connections/1', /baseUrl and socketPath/);
  });

  it('a price row whose date is not a calendar date', async () => {
    await refusedAt({ pricing: [{ ...PRICE, effectiveFrom: '2026-13-01' }] }, '/pricing/0/effectiveFrom', /calendar date/);
    await refusedAt({ pricing: [PRICE, { ...PRICE, effectiveFrom: '2026-02-30' }] }, '/pricing/1/effectiveFrom', /calendar date/);
  });

  it('a price row listed twice', async () => {
    await refusedAt({ pricing: [PRICE, { ...PRICE, inputPerMTok: 9 }] }, '/pricing/1', /listed twice/);
  });

  it('a price with more decimal places than the price scale holds', async () => {
    await refusedAt({ pricing: [{ ...PRICE, inputPerMTok: 0.0000000001 }] }, '/pricing/0/inputPerMTok', /9 decimal places/);
    await refusedAt({ pricing: [{ ...PRICE, cacheWritePerMTok: 0.0000000001 }] }, '/pricing/0/cacheWritePerMTok', /9 decimal places/);
  });

  it('an output-token bound below the smallest bound a request may carry', async () => {
    const minimum = exported<number>(protocol, 'MIN_REQUEST_OUTPUT_TOKENS', '@momonga/protocol');
    expect(minimum).toBe(16);
    const reflection = await refusalOf({ memory: { reflection: { maxTokens: minimum - 1 } } });
    expect(reflection.message).toContain(`${reflection.file}: invalid settings at /memory/reflection/maxTokens`);
    const target = await refusalOf({ models: { connections: [chatWithCeiling(minimum - 1)] } });
    expect(target.message).toContain(`${target.file}: invalid settings at /models/connections/0`);
    await loadFile({ memory: { reflection: { maxTokens: minimum } }, models: { connections: [chatWithCeiling(minimum)] } });
  });

  it('a managed server whose endpoint forms this host does not offer, with or without a home', async () => {
    const resolveModels = exported<(models: unknown, options: unknown) => unknown>(config, 'resolveModels', '@momonga/config');
    const serverRegistryOf = exported<(declared: unknown, source: string) => unknown>(config, 'serverRegistryOf', '@momonga/config');
    const absent = process.platform === 'win32' ? 'unix' : 'pipe';
    const models = { ...S4.models, servers: Object.fromEntries(Object.entries(S4.models.servers).map(([id, server]) => [id, { ...server, endpoint: { forms: [absent] } }])) };
    expect(() => resolveModels(models, { source: 'settings.json', home: undefined, warnings: [], servers: serverRegistryOf(models.servers, 'settings.json') })).toThrow(/accepts only the endpoint forms/);
    expect((await refusalOf({ models })).message).toMatch(/accepts only the endpoint forms/);
  });

  it('an MCP server name the MCP tool names cannot carry', async () => {
    const stdio = { command: '/usr/bin/true' };
    await refusedAt(withServer('my server', stdio), '/mcpServers/my server', /invalid MCP server name "my server"/);
    await refusedAt(withServer('a__b', stdio), '/mcpServers/a__b', /invalid MCP server name/);
    await refusedAt(withServer('a/b', stdio), '/mcpServers/a~1b', /invalid MCP server name/);
  });

  it('an MCP server address the connection refuses', async () => {
    await refusedAt(withServer('docs', { type: 'http', url: 'not a url' }), '/mcpServers/docs/url', /not a valid URL/);
    await refusedAt(withServer('docs', { type: 'http', url: 'ftp://mcp.example.org/x' }), '/mcpServers/docs/url', /must use https or http/);
    await refusedAt(withServer('docs', { type: 'http', url: 'https://user:pw@mcp.example.org/x' }), '/mcpServers/docs/url', /must not embed credentials/);
  });
});

describe('what the consumers accept still loads', () => {
  it('an MCP address written with a variable is judged when the variable is known, and plain http is the user\'s choice', async () => {
    await loadFile(withServer('docs', { type: 'http', url: '${MCP_DOCS_URL}' }));
    await loadFile(withServer('docs', { type: 'http', url: 'http://192.168.1.20:8080/mcp' }));
  });

  it('plain http to another computer without a credential loads with a warning', async () => {
    const { warnings } = await loadFile({ models: { connections: [ollamaConnection('http://192.168.1.20:11434')] } });
    expect(warnings.some((warning) => warning.includes('plain http to another computer'))).toBe(true);
  });

  it('every settings sample that loads is accepted by the consumers of its values', async () => {
    const upstreamEndpointOf = exported<(target: unknown) => unknown>(config, 'upstreamEndpointOf', '@momonga/config');
    const validatePriceTable = exported<(entries: unknown) => void>(protocol, 'validatePriceTable', '@momonga/protocol');
    const pricing = [PRICE, { ...PRICE, effectiveFrom: '2026-06-01', inputPerMTok: 0.000000001, cachedInputPerMTok: 0, cacheWritePerMTok: 3.75 }];
    const samples = [S1, S2, { models: { connections: [anthropic({ baseUrl: ANTHROPIC_ADDRESS })] } }, { models: { connections: [{ adapter: 'open-responses', socketPath: '/run/llm/x.sock', models: [{ id: 'm', capabilities: CAPABILITIES }] }] }, pricing }];
    for (const sample of samples) {
      const { models } = await loadFile(sample);
      for (const model of models.models.values()) {
        if (model['adapter'] !== 'managed') expect(() => upstreamEndpointOf(model)).not.toThrow();
      }
    }
    expect(() => validatePriceTable(pricing)).not.toThrow();
  });
});
