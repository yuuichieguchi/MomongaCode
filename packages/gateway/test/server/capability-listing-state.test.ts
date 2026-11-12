import { describe, expect, it } from 'vitest';
import type { Capabilities, ProviderAdapter } from '@momonga/protocol';
import { createScriptedAdapter } from '@momonga/testkit';
import { invalidRequest } from '../../src/core/errors.ts';
import { capabilityFailingAdapter } from '../capability-failing-adapter.ts';
import { getJson, startGateway } from '../gateway-helpers.ts';

const FIRST = 'a/first';
const SECOND = 'b/second';

const CAPABILITIES: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 4,
  source: 'declared',
};

const listed = (): ProviderAdapter => createScriptedAdapter({ calls: [], capabilities: CAPABILITIES });

const unavailable = (): ProviderAdapter => capabilityFailingAdapter({ inner: createScriptedAdapter({ calls: [], capabilities: CAPABILITIES }), fails: () => invalidRequest('capabilities_unknown', 'no numbers', 'model', 412) });

type Entry = { id: string; state: string; chain: Array<{ model: string; capabilities: { toolCalling?: unknown } }> };

const entryOf = async (adapters: Record<string, ProviderAdapter>, chains: Record<string, string[]>, id: string): Promise<Entry> => {
  const harness = await startGateway({ adapters, config: { targets: Object.fromEntries(Object.keys(adapters).map((canon) => [canon, {}])), chains, retry: { maxAttempts: 1, totalWaitMs: 1 } } });
  const entries = (await getJson(harness.client, '/v1/momonga/models')).body.data as Entry[];
  const found = entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`the listing has no entry ${id}`);
  return found;
};

describe('a model entry carries the state of its chain', () => {
  it('a chain whose fallback member is unavailable is degraded and lists the failed member', async () => {
    const entry = await entryOf({ [FIRST]: listed(), [SECOND]: unavailable() }, { [FIRST]: [FIRST, SECOND] }, FIRST);
    expect(entry.state).toBe('degraded');
    expect(entry.chain[1]?.capabilities.toolCalling).toMatchObject({ state: 'unavailable' });
  });

  it('a chain whose members are all listed is available', async () => {
    const entry = await entryOf({ [FIRST]: listed(), [SECOND]: listed() }, { [FIRST]: [FIRST, SECOND] }, FIRST);
    expect(entry.state).toBe('available');
  });
});
