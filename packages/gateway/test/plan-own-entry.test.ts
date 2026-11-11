import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { createMemoryCredentialStore } from '@momonga/foundation';
import { catalogKey, createPlanCatalog } from '../src/plan/catalog.ts';
import { ownEntry } from '../src/plan/own-entry.ts';
import { START_MS } from './gateway-helpers.ts';

describe('ownEntry looks a name from outside up as an own property (A7)', () => {
  it('gives the value stored under the name', () => {
    expect(ownEntry({ a: 1, b: 2 }, 'b')).toBe(2);
  });

  it.for(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'missing'])('gives nothing for %s on a record that does not hold it', (name) => {
    expect(ownEntry<unknown>({}, name)).toBeUndefined();
    expect(ownEntry<unknown>({ a: 1 }, name)).toBeUndefined();
  });

  it('gives an entry stored under an inherited name, the prototype name included', () => {
    const record: Record<string, number> = Object.fromEntries([['constructor', 1], ['__proto__', 2]]);
    expect(ownEntry(record, 'constructor')).toBe(1);
    expect(ownEntry(record, '__proto__')).toBe(2);
    expect(ownEntry(JSON.parse('{"__proto__": 3}') as Record<string, number>, '__proto__')).toBe(3);
  });

  it('gives nothing for a name the prototype of the record holds', () => {
    const record: Record<string, number> = Object.create({ inherited: 1 });
    expect(ownEntry(record, 'inherited')).toBeUndefined();
  });
});

describe('the stored plan model list is read by own names only (A7)', () => {
  const loaded = async (models: ReadonlyArray<[string, unknown]>) => {
    const store = createMemoryCredentialStore();
    const signal = new AbortController().signal;
    await store.write(catalogKey('chatgpt', 'work'), JSON.stringify({ readAt: new Date(START_MS).toISOString(), models: Object.fromEntries(models) }), signal);
    const catalog = createPlanCatalog({
      store,
      clock: createFakeClock(START_MS),
      outbound: () => Promise.reject(new Error('this test reads no upstream list')),
      sleep: () => Promise.reject(new Error('this test does not wait')),
    });
    await catalog.load('chatgpt', 'work', signal);
    return { capabilitiesOf: (model: string) => catalog.capabilitiesOf('chatgpt', 'work', model), record: await catalog.record('chatgpt', 'work', signal) };
  };

  const ENTRY = { contextWindow: 32_000, maxOutputTokens: 8_000 };

  it('a model stored under the prototype name is that model and lends its fields to no other name', async () => {
    const { capabilitiesOf, record } = await loaded([['__proto__', ENTRY], ['plain', { contextWindow: 64_000, maxOutputTokens: 16_000 }]]);
    expect(capabilitiesOf('__proto__')).toEqual(ENTRY);
    expect(capabilitiesOf('plain')).toEqual({ contextWindow: 64_000, maxOutputTokens: 16_000 });
    expect(capabilitiesOf('contextWindow')).toBeUndefined();
    expect(capabilitiesOf('source')).toBeUndefined();
    expect(Object.keys(record?.models ?? {})).toEqual(['__proto__', 'plain']);
  });

  it.for(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('the inherited name %s is no model of a list that does not hold it', async (name) => {
    const { capabilitiesOf } = await loaded([['plain', ENTRY]]);
    expect(capabilitiesOf(name)).toBeUndefined();
  });

  it('a model named constructor is read as stored', async () => {
    const { capabilitiesOf } = await loaded([['constructor', ENTRY]]);
    expect(capabilitiesOf('constructor')).toEqual(ENTRY);
  });
});
