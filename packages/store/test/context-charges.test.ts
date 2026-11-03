import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { START_MS, enqueue, harness, newSession } from './helpers.ts';

type ChargeInput = { purpose: string; runId: string | null; project: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number };

type Charges = {
  record(input: ChargeInput): ChargeInput & { id: number; createdAt: number };
  list(filter?: { runIds?: readonly string[]; project?: string }): (ChargeInput & { id: number; createdAt: number })[];
};

const chargesOf = (store: RuntimeStore): Charges => {
  const found = (store as unknown as { contextCharges?: Charges }).contextCharges;
  if (found === undefined) throw new Error('the store has no context charge API');
  return found;
};

const setup = () => {
  const { store } = harness();
  const run = enqueue(store, newSession(store).id);
  return { run, charges: chargesOf(store) };
};

const charge = (overrides: Partial<ChargeInput> = {}): ChargeInput => ({
  purpose: 'reflection',
  runId: null,
  project: '/work/a',
  model: 'fm',
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  ...overrides,
});

describe('context charges', () => {
  it('stores a charge of a run with its clock time', () => {
    const { run, charges } = setup();
    const input = charge({ runId: run.id });
    expect(charges.record(input)).toEqual({ ...input, id: 1, createdAt: START_MS });
    expect(charges.list()).toEqual([{ ...input, id: 1, createdAt: START_MS }]);
  });

  it('stores a charge with no run, which is how context improve is billed', () => {
    const { charges } = setup();
    expect(charges.record(charge({ purpose: 'guideline' }))).toMatchObject({ purpose: 'guideline', runId: null });
  });

  it('filters by run and by project', () => {
    const { run, charges } = setup();
    charges.record(charge({ runId: run.id }));
    charges.record(charge({ project: '/work/b', purpose: 'guideline' }));
    expect(charges.list({ runIds: [run.id] }).map((entry) => entry.project)).toEqual(['/work/a']);
    expect(charges.list({ project: '/work/b' }).map((entry) => entry.purpose)).toEqual(['guideline']);
    expect(charges.list({ runIds: [] })).toEqual([]);
  });

  it('records one response id once: the same charge again returns the stored one, a different charge for the id fails naming it, and charges without an id repeat freely', () => {
    const { run, charges } = setup();
    const withId = (responseId: string, runId: string | null = null, extra: Record<string, unknown> = {}) => ({ ...charge({ runId }), detail: { responseId, ...extra } });
    const first = charges.record(withId('resp_1') as never);

    expect(charges.record(withId('resp_1') as never)).toEqual(first);
    expect(charges.record(withId('resp_1', null, { timing: { durationMs: 9 } }) as never)).toEqual(first);
    expect(() => charges.record(withId('resp_1', run.id) as never)).toThrow(/resp_1/);
    expect(() => charges.record(withId('resp_1', run.id) as never)).toThrowError(expect.objectContaining({ name: 'DuplicateChargeError' }));
    expect(() => charges.record({ ...withId('resp_1'), inputTokens: 101 } as never)).toThrowError(expect.objectContaining({ name: 'DuplicateChargeError' }));
    expect(() => charges.record(withId('resp_1', null, { cachedInputTokens: 5 }) as never)).toThrowError(expect.objectContaining({ name: 'DuplicateChargeError' }));
    expect(charges.list()).toHaveLength(1);

    charges.record(withId('resp_2') as never);
    charges.record(charge());
    charges.record(charge());
    expect(charges.list()).toHaveLength(4);
  });

  it('does not take another constraint failure of a charge with a response id for a duplicate', () => {
    const { charges } = setup();
    expect(() => charges.record({ ...charge({ inputTokens: -1 }), detail: { responseId: 'resp_9' } } as never)).toThrowError(
      expect.not.objectContaining({ name: 'DuplicateChargeError' }),
    );
  });

  it('refuses an unknown purpose and a negative count', () => {
    const { charges } = setup();
    expect(() => charges.record(charge({ purpose: 'compaction' }))).toThrow();
    expect(() => charges.record(charge({ inputTokens: -1 }))).toThrow();
    expect(charges.list()).toEqual([]);
  });
});
