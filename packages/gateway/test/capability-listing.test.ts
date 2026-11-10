import { describe, expect, it } from 'vitest';
import { REDACTED_MARKER } from '@momonga/foundation';
import { TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
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

const PROBING = { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 }, source: 'unprobed' };

const probingError = () => targetProbingError({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 });

const available = () => createScriptedAdapter({ calls: [], capabilities: AVAILABLE });

const failing = (fails: () => unknown) => capabilityFailingAdapter({ inner: available(), fails });

type Entry = { id: string; capabilities: Record<string, unknown>; targetCapabilities: Record<string, Record<string, unknown>> };

const listing = async (adapters: Record<string, ReturnType<typeof available>>, aliases: Record<string, string[]>): Promise<{ status: number; entries: Entry[] }> => {
  const targets = Object.fromEntries(Object.keys(adapters).map((name) => [name, { model: `model-${name}` }]));
  const { client } = await startGateway({ credentials: [KEY], adapters, config: { aliases, targets } });
  const response = await getJson(client, '/v1/momonga/models');
  return { status: response.status, entries: response.status === 200 ? (response.body.data as Entry[]) : [] };
};

const entryOf = (entries: Entry[], id: string): Entry => {
  const found = entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no entry ${id}`);
  return found;
};

describe('the models listing gives every target what asking it for capabilities answers (P-G1)', () => {
  it('a target whose capabilities() throws capabilities_unknown is listed unavailable, and the other alias is listed with numbers', async () => {
    const { status, entries } = await listing({ A: failing(unknownNumbersOf('no numbers for A')), B: available() }, { a: ['A'], b: ['B'] });
    expect(status).toBe(200);
    const a = entryOf(entries, 'a');
    expect(a.capabilities).toEqual(unavailableOf('no numbers for A'));
    expect(a.targetCapabilities['A']).toEqual(unavailableOf('no numbers for A'));
    expect(entryOf(entries, 'b').capabilities['contextWindow']).toBe(8192);
  });

  it('an alias [B, A] (available, unavailable) is listed with the unavailable state of A and lists B with numbers in targetCapabilities', async () => {
    const { status, entries } = await listing({ A: failing(unknownNumbersOf('no numbers for A')), B: available() }, { mixed: ['B', 'A'] });
    expect(status).toBe(200);
    const mixed = entryOf(entries, 'mixed');
    expect(mixed.capabilities).toEqual(unavailableOf('no numbers for A'));
    expect(mixed.targetCapabilities['B']?.['contextWindow']).toBe(8192);
    expect(mixed.targetCapabilities['A']).toEqual(unavailableOf('no numbers for A'));
  });

  it('with two unavailable members [A1(412), A2(413)] the alias carries the state of A1', async () => {
    const { status, entries } = await listing({ A1: failing(unknownNumbersOf('first', 412)), A2: failing(unknownNumbersOf('second', 413)) }, { both: ['A1', 'A2'] });
    expect(status).toBe(200);
    const both = entryOf(entries, 'both');
    expect(both.capabilities).toEqual(unavailableOf('first', 412));
    expect(both.targetCapabilities['A2']).toEqual(unavailableOf('second', 413));
  });

  it('an adapter bug is listed unavailable', async () => {
    const { status, entries } = await listing({ A: failing(() => new TypeError(`boom ${KEY}`)) }, { a: ['A'] });
    expect(status).toBe(200);
    const a = entryOf(entries, 'a');
    expect(a.capabilities).toEqual({ toolCalling: { state: 'unavailable', status: 502, type: 'server_error', code: 'adapter_error', message: `boom ${REDACTED_MARKER}` }, source: 'unprobed' });
    expect(a.capabilities['toolCalling']).not.toHaveProperty('param');
  });

  it('a probing target is listed with the probing value and an unavailable one beside it is listed unavailable', async () => {
    const { status, entries } = await listing({ P: failing(probingError), U: failing(unknownNumbersOf('no numbers for U')) }, { probing: ['P'], unavailable: ['U'] });
    expect(status).toBe(200);
    expect(entryOf(entries, 'probing').capabilities).toEqual(PROBING);
    expect(entryOf(entries, 'unavailable').capabilities).toEqual(unavailableOf('no numbers for U'));
  });

  it('an alias [probing, unavailable] carries the probing state and [unavailable, probing] the unavailable state of its first member; targetCapabilities list each member\'s own state', async () => {
    const { status, entries } = await listing({ P: failing(probingError), U: failing(unknownNumbersOf('no numbers for U')) }, { pu: ['P', 'U'], up: ['U', 'P'] });
    expect(status).toBe(200);
    const pu = entryOf(entries, 'pu');
    const up = entryOf(entries, 'up');
    expect(pu.capabilities).toEqual(PROBING);
    expect(up.capabilities).toEqual(unavailableOf('no numbers for U'));
    for (const entry of [pu, up]) {
      expect(entry.targetCapabilities['P']).toEqual(PROBING);
      expect(entry.targetCapabilities['U']).toEqual(unavailableOf('no numbers for U'));
    }
  });

  it('an alias with an unavailable member is never listed with capabilities', async () => {
    const { status, entries } = await listing(
      { A: failing(unknownNumbersOf('no numbers for A')), A1: failing(unknownNumbersOf('first', 412)), A2: failing(unknownNumbersOf('second', 413)), B: available(), P: failing(probingError), U: failing(unknownNumbersOf('no numbers for U')) },
      { mixed: ['B', 'A'], both: ['A1', 'A2'], pu: ['P', 'U'], up: ['U', 'P'] },
    );
    expect(status).toBe(200);
    for (const id of ['mixed', 'both', 'pu', 'up']) {
      const entry = entryOf(entries, id);
      expect(entry.capabilities).not.toHaveProperty('contextWindow');
      expect(['probing', 'unavailable']).toContain((entry.capabilities['toolCalling'] as { state: string }).state);
    }
  });
});
