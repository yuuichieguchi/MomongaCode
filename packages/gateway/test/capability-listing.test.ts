import { describe, expect, it } from 'vitest';
import { REDACTED_MARKER } from '@momonga/foundation';
import { TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Capabilities, ProviderAdapter } from '@momonga/protocol';
import { createScriptedAdapter } from '@momonga/testkit';
import { invalidRequest } from '../src/core/errors.ts';
import { targetProbingError } from '../src/probe/auto-probe.ts';
import { capabilityFailingAdapter } from './capability-failing-adapter.ts';
import { getJson, startGateway } from './gateway-helpers.ts';

const KEY = 'listing-credential-value-0001';

const AVAILABLE: Capabilities = {
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

const unknownNumbersOf = (message: string, status = 412) => () => invalidRequest('capabilities_unknown', message, 'model', status);

const unavailableOf = (message: string, status = 412) => ({
  toolCalling: { state: 'unavailable', status, type: 'invalid_request', code: 'capabilities_unknown', message, param: 'model' },
  source: 'unprobed',
});

const PROBING = { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }, source: 'unprobed' };

const probingError = () => targetProbingError({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } });

const available = () => createScriptedAdapter({ calls: [], capabilities: AVAILABLE });

const failing = (fails: () => unknown) => capabilityFailingAdapter({ inner: available(), fails });

type Member = { model: string; capabilities: Record<string, unknown> };
type Entry = { id: string; capabilities: Record<string, unknown>; chain: Member[] };

const canonOf = (server: string): string => `${server}/model-${server}`;

const listing = async (adapters: Record<string, ProviderAdapter>, chains: readonly string[][]): Promise<{ status: number; entries: Entry[] }> => {
  const targets = Object.fromEntries(Object.keys(adapters).map((server) => [canonOf(server), {}]));
  const { client } = await startGateway({
    credentials: [KEY],
    adapters: Object.fromEntries(Object.entries(adapters).map(([server, adapter]) => [canonOf(server), adapter])),
    config: { targets, chains: Object.fromEntries(chains.map((members) => [canonOf(members[0] as string), members.map(canonOf)])) },
  });
  const response = await getJson(client, '/v1/momonga/models');
  return { status: response.status, entries: response.status === 200 ? (response.body.data as Entry[]) : [] };
};

const entryOf = (entries: Entry[], server: string): Entry => {
  const found = entries.find((entry) => entry.id === canonOf(server));
  if (found === undefined) throw new Error(`no entry ${server}`);
  return found;
};

const memberOf = (entry: Entry, server: string): Record<string, unknown> | undefined => entry.chain.find((member) => member.model === canonOf(server))?.capabilities;

describe('the models listing gives every member of a chain what asking it for capabilities answers (rule L)', () => {
  it('a model whose capabilities() throws capabilities_unknown is listed unavailable, and the other model is listed with numbers', async () => {
    const { status, entries } = await listing({ a: failing(unknownNumbersOf('no numbers for A')), b: available() }, [['a'], ['b']]);
    expect(status).toBe(200);
    const a = entryOf(entries, 'a');
    expect(a.capabilities).toEqual(unavailableOf('no numbers for A'));
    expect(memberOf(a, 'a')).toEqual(unavailableOf('no numbers for A'));
    expect(entryOf(entries, 'b').capabilities['contextWindow']).toBe(8192);
  });

  it('a chain [b, a] (available, unavailable) is listed with the numbers of b, and a shows its unavailable state among the members', async () => {
    const { status, entries } = await listing({ b: available(), a: failing(unknownNumbersOf('no numbers for A')) }, [['b', 'a'], ['a']]);
    expect(status).toBe(200);
    const mixed = entryOf(entries, 'b');
    expect(mixed.capabilities['contextWindow']).toBe(8192);
    expect(memberOf(mixed, 'b')?.['contextWindow']).toBe(8192);
    expect(memberOf(mixed, 'a')).toEqual(unavailableOf('no numbers for A'));
  });

  it('with two unavailable members [a1(412), a2(413)] the model carries the state of a1, its own', async () => {
    const { status, entries } = await listing({ a1: failing(unknownNumbersOf('first', 412)), a2: failing(unknownNumbersOf('second', 413)) }, [['a1', 'a2'], ['a2']]);
    expect(status).toBe(200);
    const both = entryOf(entries, 'a1');
    expect(both.capabilities).toEqual(unavailableOf('first', 412));
    expect(memberOf(both, 'a2')).toEqual(unavailableOf('second', 413));
  });

  it('an adapter bug is listed unavailable', async () => {
    const { status, entries } = await listing({ a: failing(() => new TypeError(`boom ${KEY}`)) }, [['a']]);
    expect(status).toBe(200);
    const a = entryOf(entries, 'a');
    expect(a.capabilities).toEqual({ toolCalling: { state: 'unavailable', status: 502, type: 'server_error', code: 'adapter_error', message: `boom ${REDACTED_MARKER}` }, source: 'unprobed' });
    expect(a.capabilities['toolCalling']).not.toHaveProperty('param');
  });

  it('a probing model is listed with the probing value and an unavailable one beside it is listed unavailable', async () => {
    const { status, entries } = await listing({ p: failing(probingError), u: failing(unknownNumbersOf('no numbers for U')) }, [['p'], ['u']]);
    expect(status).toBe(200);
    expect(entryOf(entries, 'p').capabilities).toEqual(PROBING);
    expect(entryOf(entries, 'u').capabilities).toEqual(unavailableOf('no numbers for U'));
  });

  it('a chain [probing, unavailable] carries the probing state and [unavailable, probing] the unavailable state of its first member; the members list each one\'s own state', async () => {
    const { status, entries } = await listing({ p: failing(probingError), u: failing(unknownNumbersOf('no numbers for U')) }, [['p', 'u'], ['u', 'p']]);
    expect(status).toBe(200);
    const pu = entryOf(entries, 'p');
    const up = entryOf(entries, 'u');
    expect(pu.capabilities).toEqual(PROBING);
    expect(up.capabilities).toEqual(unavailableOf('no numbers for U'));
    for (const entry of [pu, up]) {
      expect(memberOf(entry, 'p')).toEqual(PROBING);
      expect(memberOf(entry, 'u')).toEqual(unavailableOf('no numbers for U'));
    }
  });

  it('a model that is itself probing or unavailable is never listed with capabilities, whatever follows it', async () => {
    const { status, entries } = await listing(
      { a1: failing(unknownNumbersOf('first', 412)), b: available(), p: failing(probingError) },
      [['a1', 'b'], ['p', 'b'], ['b']],
    );
    expect(status).toBe(200);
    for (const server of ['a1', 'p']) {
      const entry = entryOf(entries, server);
      expect(entry.capabilities).not.toHaveProperty('contextWindow');
      expect(['probing', 'unavailable']).toContain((entry.capabilities['toolCalling'] as { state: string }).state);
    }
  });
});
