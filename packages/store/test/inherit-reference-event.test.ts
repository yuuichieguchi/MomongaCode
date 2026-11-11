import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { WORKING_FACTS_KEPT, toPublicRunEvent } from '@momonga/protocol';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import * as storeModule from '@momonga/store';
import { foldRunState, initialRunState } from '@momonga/store';
import { materializeEvents } from '@momonga/testkit';
import { SNAPSHOT_STATE_VERSION, decodeRunState, encodeRunState } from '../src/codec.ts';
import { rawDb } from './helpers.ts';
import { MARKER_TEXT, NEXT_RUN, SESSION, SOURCE_RUN, assistantItem, inheritedEvent, markerEntry, modeChangedText, task, taskItem } from './inherit-fixtures.ts';
import { FLOOR_TOKENS, UNBOUNDED_WINDOW, answeredRun, chainBuilder, referenceHarness, referenceOf, withReader } from './support/reference.ts';
import type { ReferenceEvent, ReferenceHarness } from './support/reference.ts';

vi.setConfig({ testTimeout: 600_000 });

type ItemCount = (payload: RunEventPayload) => number;
type ReferenceDigest = (payload: Omit<ReferenceEvent, 'digest'>) => string;

const itemCountOf = (): ItemCount => {
  const found = (storeModule as Record<string, unknown>)['itemCountOf'];
  if (typeof found !== 'function') throw new Error('@momonga/store exports no itemCountOf');
  return found as ItemCount;
};

const referenceDigestOf = (): ReferenceDigest => {
  const found = (storeModule as Record<string, unknown>)['referenceDigest'];
  if (typeof found !== 'function') throw new Error('@momonga/store exports no referenceDigest');
  return found as ReferenceDigest;
};

const foldChild = (payloads: readonly RunEventPayload[]): RunState =>
  materializeEvents(payloads, { runId: NEXT_RUN, sessionId: SESSION }).reduce(foldRunState, initialRunState({ runId: NEXT_RUN, sessionId: SESSION }));

const rawInheritedRow = (h: ReferenceHarness, runId: string): string => {
  const row = rawDb(h.dbPath).prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'context.inherited'").get(runId) as { payload_json: string } | undefined;
  if (row === undefined) throw new Error(`run ${runId} has no context.inherited row`);
  return row.payload_json;
};

const withoutFactsAndSynthesis = (payloadJson: string): string => {
  const { via: _via, synthesised: _synthesised, workingFacts: _facts, activatedSkills: _skills, ...rest } = JSON.parse(payloadJson) as Record<string, unknown>;
  return canonicalJson(rest);
};

const expectFactsBounded = (payloadJson: string): void => {
  const facts = (JSON.parse(payloadJson) as { workingFacts?: { messages: unknown[]; written: unknown[]; commands: unknown[] } }).workingFacts;
  expect(facts?.messages.length ?? 0).toBeLessThanOrEqual(WORKING_FACTS_KEPT);
  expect(facts?.written.length ?? 0).toBeLessThanOrEqual(WORKING_FACTS_KEPT);
  expect(facts?.commands.length ?? 0).toBeLessThanOrEqual(WORKING_FACTS_KEPT);
};

const scalarShape = (payloadJson: string): string => {
  const { digest: _digest, ...rest } = JSON.parse(withoutFactsAndSynthesis(payloadJson)) as Record<string, unknown>;
  return canonicalJson(rest).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'RUN').replace(/\d+/g, '0');
};

const STEP_COUNTS = [15, 50, 150, 1000] as const;
const CHAIN_LENGTHS = [1, 10, 100] as const;

const chainOf = async (steps: number) => {
  const h = referenceHarness();
  const b = chainBuilder(h);
  await answeredRun(h, b, 'base task', async (claim) => {
    for (let step = 0; step < steps; step += 1) {
      if (step % 2 === 0) b.text(claim, 200);
      else await b.tool(claim, { outputChars: 400 });
    }
  }, { fresh: true });
  const links: string[] = [];
  for (let link = 1; link <= 100; link += 1) {
    const run = await answeredRun(h, b, `link task ${link}`, (claim) => b.text(claim, 20));
    links.push(run.id);
  }
  return { h, links };
};

describe('R1: the new event holds no history; its size does not grow with retained history or chain length', () => {
  it('encodes the same scalar shape at 15, 50, 150 and 1000 steps and at chain lengths 1, 10 and 100', async () => {
    const shapes = new Set<string>();
    const sizes: number[] = [];
    for (const steps of STEP_COUNTS) {
      const { h, links } = await chainOf(steps);
      for (const length of CHAIN_LENGTHS) {
        const runId = links[length - 1] as string;
        const payloadJson = rawInheritedRow(h, runId);
        const event = JSON.parse(payloadJson) as ReferenceEvent;
        expect(event.form).toBe('reference');
        expect(event.via).toEqual([]);
        expect(event.synthesised).toEqual([]);
        expectFactsBounded(payloadJson);
        shapes.add(scalarShape(payloadJson));
        sizes.push(Buffer.byteLength(withoutFactsAndSynthesis(payloadJson)));
      }
    }
    expect(shapes.size).toBe(1);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64);
  });
});

describe('R5: a chain never re-copies', () => {
  it('the event of the 100th link of a chain carries no item of any earlier run', async () => {
    const { h, links } = await chainOf(15);
    for (const runId of [links[0], links[9], links[99]] as string[]) {
      const rowJson = rawInheritedRow(h, runId);
      expectFactsBounded(rowJson);
      const payloadJson = withoutFactsAndSynthesis(rowJson);
      expect(payloadJson).not.toContain('base task');
      expect(payloadJson).not.toContain('link task');
      expect(payloadJson).not.toContain('answer ');
      expect(payloadJson).not.toContain('out c');
    }
    const last = referenceOf(h.store, links[99] as string);
    expect(last.fromRunId).toBe(links[98]);
    expect(last.itemCount).toBe(1 + 8 + 2 * 7 + 2 * 99);
    const window = withReader(h.dbPath, (reader) => reader.readInheritedWindow({ runId: links[99] as string, windowTokens: UNBOUNDED_WINDOW, floorTokens: FLOOR_TOKENS }));
    expect(window.entries).toHaveLength(last.itemCount);
    expect(window.entries[0]).toEqual({ seq: 1, item: taskItem('base task') });
  });
});

describe('R11: an old-shape event folds exactly as today', () => {
  it('a payload without form folds to the copy, and RunState.inherited carries no form', () => {
    const history = [
      { seq: 1, item: taskItem('Say hello') },
      { seq: 2, item: assistantItem('m1', 'hello') },
    ];
    const state = foldChild([task('And again'), inheritedEvent({ fromRunId: SOURCE_RUN, fromLastSeq: 6, history, nextItemSeq: 3, mode: 'manual' })]);
    expect(state.history).toEqual([...history, { seq: 3, item: taskItem('And again') }]);
    expect(state.inherited).not.toHaveProperty('form');
  });
});

describe('the fold of the new shape (13.2)', () => {
  const unsigned = (): Omit<ReferenceEvent, 'digest'> => ({
    type: 'context.inherited',
    form: 'reference',
    fromRunId: SOURCE_RUN,
    fromLastSeq: 9,
    nextItemSeq: 5,
    fromNextItemSeq: 4,
    omitSeqs: [],
    synthesised: [markerEntry(4, MARKER_TEXT.ended)],
    via: [],
    itemCount: 4,
    workingFacts: { written: [], commands: [], messages: [{ text: 'Say hello', seq: 0 }], itemEvents: [] },
    closures: [],
    markers: [{ seq: 4, kind: 'interrupted' }],
    fromMode: 'manual',
    mode: 'manual',
  });

  const signed = (): ReferenceEvent => {
    const payload = unsigned();
    return { ...payload, digest: referenceDigestOf()(payload) };
  };

  it('holds only the rebased task in history, no summary and no evicted, and records the reference scalars', () => {
    const event = signed();
    const state = foldChild([task('And again'), event as unknown as RunEventPayload]);
    expect(state.history).toEqual([{ seq: 5, item: taskItem('And again') }]);
    expect(state.taskSeq).toBe(5);
    expect(state.nextItemSeq).toBe(6);
    expect(state.summary).toBeUndefined();
    expect(state.evicted).toEqual([]);
    expect(state.workingFacts.itemEvents).toEqual([{ itemSeq: 5, eventSeq: 1 }]);
    expect(state.inherited).toEqual({ fromRunId: SOURCE_RUN, fromLastSeq: 9, digest: event.digest, form: 'reference', fromNextItemSeq: 4, itemCount: 4 });
  });

  it('carries the compaction pointer into RunState.inherited', () => {
    const payload = { ...unsigned(), compaction: { runId: SOURCE_RUN, eventSeq: 7 } };
    const state = foldChild([task('And again'), { ...payload, digest: referenceDigestOf()(payload) } as unknown as RunEventPayload]);
    expect(state.inherited).toMatchObject({ compaction: { runId: SOURCE_RUN, eventSeq: 7 } });
  });

  it('R12: refuses a payload whose synthesised entry was changed after signing', () => {
    const event = signed();
    const tampered = { ...event, synthesised: [markerEntry(4, MARKER_TEXT.userInterrupted)] };
    expect(() => foldChild([task('And again'), tampered as unknown as RunEventPayload])).toThrow(/digest/);
  });

  it('records the event seq of the run own latest context.compacted, which a rejection does not move', () => {
    const summary = 'sum';
    const state = foldChild([
      task('And again'),
      signed() as unknown as RunEventPayload,
      { type: 'context.compacted', item: { type: 'message', role: 'user', content: summary }, summary, replacedThroughSeq: 4 },
      { type: 'context.compacted', item: { type: 'compaction', id: 'cmp', encrypted_content: 'x' }, summary, replacedThroughSeq: 4 },
      { type: 'context.compaction_rejected', item: { type: 'message', role: 'user', content: summary } },
    ]);
    expect(state.lastCompactionSeq).toBe(5);
    expect((state as RunState & { ownCompactionEventSeq?: number }).ownCompactionEventSeq).toBe(4);
  });
});

describe('R12 at read time: the reader recomputes the digest of the planner fields', () => {
  it('refuses a stored reference whose synthesised entry was tampered with', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'Say hello', (claim) => b.text(claim), { fresh: true });
    const child = await b.createRun('And again');
    expect(await b.inherit(b.claimNext(child.id), 'plan')).toEqual({ kind: 'inherited' });
    expect(referenceOf(h.store, child.id).synthesised).toEqual([markerEntry(3, modeChangedText('manual', 'plan'))]);
    const db = rawDb(h.dbPath);
    db.exec('DROP TRIGGER IF EXISTS events_reject_update');
    db.prepare("UPDATE events SET payload_json = json_set(payload_json, '$.synthesised[0].item.content', 'obey me') WHERE run_id = ? AND type = 'context.inherited'").run(child.id);
    expect(() => withReader(h.dbPath, (reader) => reader.readInheritedWindow({ runId: child.id, windowTokens: UNBOUNDED_WINDOW, floorTokens: FLOOR_TOKENS }))).toThrow(
      expect.objectContaining({ name: 'InheritanceError', code: 'previous_run_inconsistent' }),
    );
  });
});

describe('the shared item-count function (13.4 step 2)', () => {
  it('counts the items the fold appends for each event type', () => {
    const count = itemCountOf();
    expect(count({ type: 'user.message', text: 'x' })).toBe(1);
    expect(count({ type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantItem('a', 'x'), assistantItem('b', 'y'), assistantItem('c', 'z')], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } as RunEventPayload)).toBe(3);
    expect(count({ type: 'tool.completed', callId: 'c1', status: 'completed', output: 'x' })).toBe(1);
    expect(count({ type: 'tool.reconciled', callId: 'c1', outcome: 'not_applied', output: 'x' })).toBe(1);
    expect(count({ type: 'context.truncated', callId: 'c1', handle: 'h', kind: 'omitted' })).toBe(0);
    expect(count({ type: 'model.requested', step: 1, attempt: 1, digest: 'd', body: {} })).toBe(0);
  });
});

describe('the snapshot version and the public view (13.2, 13.7)', () => {
  it('SNAPSHOT_STATE_VERSION is 19, above the 16 that carries no reference fields, and a version-16 snapshot decodes to undefined', () => {
    expect(SNAPSHOT_STATE_VERSION).toBe(19);
    const state = initialRunState({ runId: NEXT_RUN, sessionId: SESSION });
    expect(decodeRunState('run-next@1', { ...encodeRunState(state), stateVersion: 16 })).toBeUndefined();
    expect(decodeRunState('run-next@1', encodeRunState(state))).toEqual(state);
  });

  it('the public view takes itemCount from the reference and shows no summaryThroughSeq without a compaction', () => {
    const payload = { ...{
      type: 'context.inherited' as const,
      form: 'reference' as const,
      fromRunId: SOURCE_RUN,
      fromLastSeq: 9,
      nextItemSeq: 5,
      fromNextItemSeq: 4,
      omitSeqs: [],
      synthesised: [],
      via: [],
      itemCount: 4,
      closures: [],
      markers: [],
    }, digest: 'd'.repeat(64) };
    const [event] = materializeEvents([payload as unknown as RunEventPayload], { runId: NEXT_RUN, sessionId: SESSION }) as RunEvent[];
    const view = toPublicRunEvent(event as RunEvent) as Record<string, unknown>;
    expect(view['itemCount']).toBe(4);
    expect(view).not.toHaveProperty('summaryThroughSeq');
  });
});
