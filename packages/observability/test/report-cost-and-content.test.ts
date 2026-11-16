import { describe, expect, it } from 'vitest';
import * as observability from '@momonga/observability';
import type { BodyRecord, SpanRecord, TraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, openStore } from './helpers.ts';

type CallPrice = { kind: 'priced'; units: string; priceVersion: string } | { kind: 'unpriced'; code: string; reason: string } | { kind: 'not_recorded' };
type RunCost = { runId: string; calls: number; notPriced: number; priced: { currency: 'USD'; priceVersion: string; units: string }[] };
type RunCostsOf = (runIds: readonly string[], calls: readonly { runId: string; price: CallPrice }[]) => RunCost[];
type StoredBody = { id: number; body: BodyRecord };
type BodyStore = TraceStore & { bodiesOfRunAfter(runId: string, afterId: number, limit: number): StoredBody[] };
type ContentPage = { bodies: { id: number; spanId: string; kind: string; content: string; createdAtMs: number; expiresAtMs: number }[]; next: number | null };
type PageRunBodies = (store: TraceStore, runId: string, afterId: number, limit: number) => ContentPage;

const exported = <T>(name: string): T => {
  const value = (observability as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@momonga/observability does not export ${name}`);
  return value as T;
};

const span = (spanId: string, runId: string | null): SpanRecord => ({
  traceId: 'trace-1',
  spanId,
  parentSpanId: null,
  name: 'chat',
  kind: 'CLIENT',
  startMs: START_MS,
  endMs: START_MS + 5,
  status: 'OK',
  attributes: {},
  events: [],
  runId,
});

const body = (spanId: string, content: string, expiresAtMs: number): BodyRecord => ({
  traceId: 'trace-1',
  spanId,
  kind: observability.BODY_KINDS[0] as BodyRecord['kind'],
  content,
  createdAtMs: START_MS,
  expiresAtMs,
});

describe('runCostsOf (X6: the priced units of the billed calls of each run)', () => {
  it('sums the priced units of a run per price version, counts every call and the calls that are not priced, and keeps the order of the asked run ids', () => {
    const runCostsOf = exported<RunCostsOf>('runCostsOf');
    const costs = runCostsOf(
      ['run-b', 'run-a', 'run-empty'],
      [
        { runId: 'run-a', price: { kind: 'priced', units: '1000', priceVersion: '2026-01-01' } },
        { runId: 'run-a', price: { kind: 'priced', units: '9007199254740993', priceVersion: '2026-01-01' } },
        { runId: 'run-a', price: { kind: 'priced', units: '5', priceVersion: '2026-06-01' } },
        { runId: 'run-a', price: { kind: 'unpriced', code: 'no_price_entry', reason: 'no price entry' } },
        { runId: 'run-a', price: { kind: 'not_recorded' } },
        { runId: 'run-b', price: { kind: 'priced', units: '0', priceVersion: 'local' } },
      ],
    );
    expect(costs).toEqual([
      { runId: 'run-b', calls: 1, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [{ currency: 'USD', priceVersion: 'local', units: '0' }] },
      {
        runId: 'run-a',
        calls: 5,
        retries: 0,
        notPriced: 2,
        legacyPrecisionCalls: 0,
        priced: [
          { currency: 'USD', priceVersion: '2026-01-01', units: '9007199254741993' },
          { currency: 'USD', priceVersion: '2026-06-01', units: '5' },
        ],
      },
      { runId: 'run-empty', calls: 0, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] },
    ]);
  });

  it('refuses a call of a run that was not asked for', () => {
    const runCostsOf = exported<RunCostsOf>('runCostsOf');
    expect(() => runCostsOf(['run-a'], [{ runId: 'run-x', price: { kind: 'not_recorded' } }])).toThrow(/run-x/);
  });
});

describe('the stored bodies of a run (trace --content)', () => {
  const filled = (): { store: BodyStore; clock: ReturnType<typeof createFakeClock> } => {
    const clock = createFakeClock(START_MS);
    const { store } = openStore(clock);
    store.writeSpans(
      [span('span-1', 'run-1'), span('span-2', 'run-1'), span('span-other', 'run-2')],
      [
        body('span-1', 'first', START_MS + 1000),
        body('span-other', 'of another run', START_MS + 1000),
        body('span-2', 'second', START_MS + 1000),
        body('span-2', 'expired', START_MS + 10),
        body('span-1', 'third', START_MS + 1000),
      ],
    );
    return { store: store as BodyStore, clock };
  };

  it('reads the bodies of the spans of one run in the order they were stored, after a cursor and up to a count, whatever expiry was written with them', () => {
    const { store, clock } = filled();
    clock.advance(20);
    const first = store.bodiesOfRunAfter('run-1', 0, 2);
    expect(first.map((entry) => entry.body.content)).toEqual(['first', 'second']);
    const rest = store.bodiesOfRunAfter('run-1', (first[1] as StoredBody).id, 3);
    expect(rest.map((entry) => entry.body.content)).toEqual(['expired', 'third']);
  });

  it('pages them with a next cursor that is null on the last page, and refuses a count outside the page bound', () => {
    const { store, clock } = filled();
    clock.advance(20);
    const pageRunBodies = exported<PageRunBodies>('pageRunBodies');
    const bound = exported<number>('MAX_TRACE_CONTENT_PAGE');
    const first = pageRunBodies(store, 'run-1', 0, 2);
    expect(first.bodies.map((entry) => entry.content)).toEqual(['first', 'second']);
    expect(first.bodies[0]).toMatchObject({ spanId: 'span-1', createdAtMs: START_MS, expiresAtMs: START_MS + 1000 });
    expect(first.next).toBe((first.bodies[1] as { id: number }).id);
    const last = pageRunBodies(store, 'run-1', first.next as number, 2);
    expect(last.bodies.map((entry) => entry.content)).toEqual(['expired', 'third']);
    expect(last.next).toBeNull();
    expect(() => pageRunBodies(store, 'run-1', 0, bound + 1)).toThrow(RangeError);
    expect(() => pageRunBodies(store, 'run-1', 0, 0)).toThrow(RangeError);
  });
});

describe('the unit of a cost on the wire', () => {
  it('COST_UNIT_DIGITS is the number of decimal places of one unit of the price table', async () => {
    const { COST_UNIT_DIGITS } = (await import('@momonga/protocol')) as unknown as { COST_UNIT_DIGITS: number };
    expect(exported<(units: bigint) => number>('amountOfUnits')(10n ** BigInt(COST_UNIT_DIGITS))).toBe(1);
  });
});
