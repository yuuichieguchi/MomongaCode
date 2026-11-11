import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@momonga/foundation';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { JOURNAL_SCAN_RANGE_ROWS, JournalThreadError, createJournalReader, openRuntimeStore } from '@momonga/store';
import type { Run, RuntimeStore } from '@momonga/store';
import { createFakeClock, PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { START_MS, enqueue, harness, makeStoreDir, mustClaim, mustRun, newSession, registerCleanup, UNASKED_COMMANDS } from './helpers.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const DELTAS = 6_000;

const responded = (step: number): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});

const delta = (index: number): RunEventPayload => ({ type: 'agent.message.delta', step: 1, attempt: 1, itemId: 'msg_1', text: `piece ${index}` });

type VisitingReader = { visitRun(runId: string, types: readonly RunEvent['type'][], visit: (event: RunEvent) => void): Run };

const visiting = (reader: unknown): VisitingReader => {
  const visitRun = (reader as Partial<VisitingReader>).visitRun;
  if (typeof visitRun !== 'function') throw new Error('the journal reader has no visitRun');
  return reader as VisitingReader;
};

const seeded = () => {
  const h = harness();
  const run = enqueue(h.store, newSession(h.store).id);
  const claim = mustClaim(h.store, 'w1');
  expect(h.store.append(claim, [responded(1), ...Array.from({ length: DELTAS }, (_unused, index) => delta(index)), responded(2)]).kind).toBe('ok');
  const db = openDatabase(h.dbPath);
  registerCleanup(() => db.close());
  return { h, run, db };
};

describe('visitRun: the reader the new request kinds fold through', () => {
  it('visits exactly the events of the asked types in seq order and returns the run row of the same snapshot', () => {
    const { h, run, db } = seeded();
    const seen: string[] = [];

    const visited = visiting(createJournalReader(db)).visitRun(run.id, ['model.responded'], (event) => seen.push(`${event.type}:${event.seq}`));

    const lastSeq = mustRun(h.store, run.id).lastSeq;
    expect(seen).toEqual(['model.responded:2', `model.responded:${DELTAS + 3}`]);
    expect(visited).toMatchObject({ id: run.id, lastSeq });
  });

  it('decodes at most one row and steps at most K rows between two unit() calls, whatever the type mix', () => {
    const { run, db } = seeded();
    const trace = { units: 0, decodedSinceUnit: 0, maxDecodedBetweenUnits: 0, steppedSinceUnit: 0, maxSteppedBetweenUnits: 0, visits: 0 };
    const reader = createJournalReader(db, {
      unit: () => {
        trace.units += 1;
        trace.maxDecodedBetweenUnits = Math.max(trace.maxDecodedBetweenUnits, trace.decodedSinceUnit);
        trace.maxSteppedBetweenUnits = Math.max(trace.maxSteppedBetweenUnits, trace.steppedSinceUnit);
        trace.decodedSinceUnit = 0;
        trace.steppedSinceUnit = 0;
      },
      onDecode: (rows: number) => {
        trace.decodedSinceUnit += rows;
      },
      onRowsStepped: (rows: number) => {
        trace.steppedSinceUnit += rows;
      },
    });

    visiting(reader).visitRun(run.id, ['agent.message.delta', 'model.responded'], () => {
      trace.visits += 1;
    });

    expect(trace.visits).toBe(DELTAS + 2);
    expect(trace.maxDecodedBetweenUnits).toBeLessThanOrEqual(1);
    expect(trace.maxSteppedBetweenUnits).toBeLessThanOrEqual(JOURNAL_SCAN_RANGE_ROWS);
    expect(trace.decodedSinceUnit).toBe(0);
  });

  it('calls unit() once per visited event, so the caller fold work of one event sits in one unit', () => {
    const { run, db } = seeded();
    const order: string[] = [];
    const reader = createJournalReader(db, { unit: () => order.push('unit') });

    visiting(reader).visitRun(run.id, ['model.responded'], () => order.push('visit'));

    const visits = order.flatMap((entry, index) => (entry === 'visit' ? [index] : []));
    expect(visits).toHaveLength(2);
    for (const index of visits) expect(order[index + 1]).toBe('unit');
  });
});

type JournalFacts = {
  verdict(request: { runId: string; commands: readonly string[]; manifests: readonly string[] }): Promise<unknown>;
  evidence(request: { runId: string; paths: readonly string[] }): Promise<unknown>;
  reflectionInput(request: { runId: string; project: string; capabilities: unknown }): Promise<unknown>;
};

const journalFactsOf = (store: RuntimeStore): JournalFacts => {
  const facts = (store as unknown as { journalFacts?: JournalFacts }).journalFacts;
  if (facts === undefined) throw new Error('the runtime store exposes no journalFacts');
  return facts;
};

describe('store.journalFacts: the main thread reaches the new kinds only through the preparer port', () => {
  it('forwards each request to the preparer unchanged and decodes no journal row on the main thread', async () => {
    const dir = makeStoreDir();
    const calls: unknown[] = [];
    let decoded = 0;
    const answer = { lastSeq: 7, verified: true, facts: [] };
    const store = openRuntimeStore({ unaskedCommands: UNASKED_COMMANDS,
      path: path.join(dir, 'runtime.db'),
      home: dir,
      clock: createFakeClock(START_MS),
      leaseMs: 30_000,
      maxAttempts: 5,
      maxTotalAttempts: 1000,
      preparer: {
        measure: async () => {
          throw new Error('no terminal is measured in this test');
        },
        verdict: async (request: unknown) => (calls.push(request), answer),
      } as never,
      onDecode: (rows) => {
        decoded += rows;
      },
    });
    registerCleanup(() => store.close());
    const run = enqueue(store, newSession(store).id);
    decoded = 0;

    const reply = await journalFactsOf(store).verdict({ runId: run.id, commands: ['npm test'], manifests: [] });

    expect(reply).toBe(answer);
    expect(calls).toEqual([{ runId: run.id, commands: ['npm test'], manifests: [] }]);
    expect(decoded).toBe(0);
  });

  it.each(['verdict', 'evidence', 'reflectionInput'] as const)('rejects %s with a JournalThreadError when the store has no journal thread, and never computes it inline', async (method) => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const facts = journalFactsOf(h.store);
    const requests = {
      verdict: () => facts.verdict({ runId: run.id, commands: [], manifests: [] }),
      evidence: () => facts.evidence({ runId: run.id, paths: [] }),
      reflectionInput: () => facts.reflectionInput({ runId: run.id, project: '/work/a', capabilities: {} }),
    };

    await expect(requests[method]()).rejects.toBeInstanceOf(JournalThreadError);
  });
});
