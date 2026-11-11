import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode, RunState } from '@momonga/protocol';
import type { Run } from '@momonga/store';
import { mustRun, rawDb } from './helpers.ts';
import { MARKER_TEXT, markerEntry, taskItem } from './inherit-fixtures.ts';
import { seeded } from './support/seeded.ts';
import {
  FLOOR_TOKENS,
  UNBOUNDED_WINDOW,
  answeredRun,
  chainBuilder,
  deliveredCallIds,
  expectedEntries,
  generatedRun,
  oracleProjection,
  oracleState,
  ownState,
  recordedTokens,
  referenceHarness,
  referenceOf,
  withReader,
} from './support/reference.ts';
import type { ChainBuilder, ReferenceHarness, WindowEntry } from './support/reference.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const CASES = 40;
const CHAIN_LENGTHS = [1, 1, 2, 2, 3, 10] as const;

const inheritingChild = async (h: ReferenceHarness, b: ChainBuilder, mode: PermissionMode = 'manual'): Promise<Run> => {
  const child = b.createRun('the child task');
  const claim = b.claimNext(child.id);
  const result = await b.inherit(claim, mode);
  expect(result).toEqual({ kind: 'inherited' });
  return mustRun(h.store, child.id);
};

const windowOf = (h: ReferenceHarness, runId: string, windowTokens = UNBOUNDED_WINDOW) =>
  withReader(h.dbPath, (reader) => reader.readInheritedWindow({ runId, windowTokens, floorTokens: FLOOR_TOKENS }));

const inheritedPart = (state: RunState): RunState['history'] => state.history.filter((entry) => entry.seq < state.taskSeq);

const assertEquivalent = (h: ReferenceHarness, child: Run, mode: PermissionMode, label: string): void => {
  const event = referenceOf(h.store, child.id);
  expect(event, label).toMatchObject({ form: 'reference' });
  expect(event, label).not.toHaveProperty('history');
  expect(event, label).not.toHaveProperty('summary');
  expect(event, label).not.toHaveProperty('evicted');

  const oraclePayload = oracleProjection(h.store, { ...child, lastSeq: 1 }, mode);
  const oracle = oracleState(h.store, child.id);
  expect(event.nextItemSeq, label).toBe(oraclePayload.nextItemSeq);
  expect(event.itemCount, label).toBe(oraclePayload.history.length);
  expect(event.closures, label).toEqual(oraclePayload.closures);
  expect(event.markers, label).toEqual(oraclePayload.markers);
  expect(event.partial, label).toEqual(oraclePayload.partial);
  expect(event.mode, label).toEqual(oraclePayload.mode);
  expect(event.fromMode, label).toEqual(oraclePayload.fromMode);
  expect(event.workingFacts, label).toEqual(oraclePayload.workingFacts);
  const synthesisedSeqs = new Set([...oraclePayload.closures.map((closure) => closure.seq), ...oraclePayload.markers.map((marker) => marker.seq), ...(oraclePayload.partial === undefined ? [] : [oraclePayload.partial.seq])]);
  expect(event.synthesised, label).toEqual(oraclePayload.history.filter((entry) => synthesisedSeqs.has(entry.seq)));

  const own = ownState(h.store, child.id);
  expect(own.history, label).toEqual([{ seq: oraclePayload.nextItemSeq, item: taskItem('the child task') }]);
  expect(own.summary, label).toBeUndefined();
  expect(own.evicted, label).toEqual([]);
  expect(own.taskSeq, label).toBe(oraclePayload.nextItemSeq);
  expect(own.inherited, label).toMatchObject({ form: 'reference', fromRunId: event.fromRunId, fromLastSeq: event.fromLastSeq, fromNextItemSeq: event.fromNextItemSeq, itemCount: oraclePayload.history.length, digest: event.digest });

  const window = windowOf(h, child.id);
  const expected = expectedEntries(inheritedPart(oracle), oracle.evicted, recordedTokens(h.store, h.sessionId));
  expect(window.entries, label).toEqual(expected);
  expect(window.omittedOlder, label).toBe(false);
  expect(window.summary, label).toEqual(oracle.summary);
  const delivered = deliveredCallIds(window.entries);
  expect([...window.evicted].sort(), label).toEqual(oracle.evicted.filter((callId) => delivered.has(callId)).sort());
  expect(window.lastSeq, label).toBe(mustRun(h.store, child.id).lastSeq);
};

const assertBounded = (h: ReferenceHarness, child: Run, windowTokens: number, label: string): void => {
  const full = windowOf(h, child.id).entries;
  const bounded = windowOf(h, child.id, windowTokens);
  expect(bounded.entries.length, label).toBeGreaterThan(0);
  expect(bounded.entries.length, label).toBeLessThanOrEqual(windowTokens + 1);
  expect(bounded.entries, label).toEqual(full.slice(full.length - bounded.entries.length));
  expect(bounded.omittedOlder, label).toBe(bounded.entries.length < full.length);
  const delivered = deliveredCallIds(bounded.entries);
  expect(bounded.evicted.every((callId) => delivered.has(callId)), label).toBe(true);
};

describe('R2: the reference resolves to the history the copy held, over seeded chains (13.7 point 1)', () => {
  it(`agrees with foldedRun + projectInheritance + applyInheritance for ${CASES} seeded journals`, async () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = seeded(seed);
      const h = referenceHarness();
      const b = chainBuilder(h);
      const length = random.pick(CHAIN_LENGTHS);
      const oldShapeAt = length > 1 && seed % 3 === 0 ? 1 + (seed % (length - 1)) : -1;
      for (let index = 0; index < length; index += 1) {
        await generatedRun(h, b, random, index, { fresh: index === 0, oldShape: index === oldShapeAt });
      }
      const mode: PermissionMode = random.chance(0.3) ? 'acceptEdits' : 'manual';
      const child = await inheritingChild(h, b, mode);
      assertEquivalent(h, child, mode, `seed ${seed}`);
      for (const windowTokens of [1, 7, 60]) assertBounded(h, child, windowTokens, `seed ${seed} window ${windowTokens}`);
    }
  });
});

describe('R2 on fixed journals: every shape 13.7 lists', () => {
  it('a completed conversation', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'Say hello', (claim) => b.text(claim), { fresh: true });
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'completed');
  });

  it('a mode change adds a mode_changed marker to synthesised', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'Say hello', (claim) => b.text(claim), { fresh: true });
    const child = await inheritingChild(h, b, 'plan');
    assertEquivalent(h, child, 'plan', 'mode change');
    expect(referenceOf(h.store, child.id).markers).toEqual([{ seq: 3, kind: 'mode_changed' }]);
  });

  it('closures for an unstarted and a started dangling call, and the partial message', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'Write it', (claim) => b.openCall(claim, true), { fresh: true, ending: { to: 'STOPPED', stopReason: 'timeout' } });
    await answeredRun(h, b, 'Again', (claim) => b.openCall(claim, false), { ending: { to: 'CANCELLED' } });
    await answeredRun(h, b, 'Stream', (claim) => b.partial(claim), { ending: { to: 'FAILED', code: 'server_error' } });
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'closures and partial');
  });

  it('a task the user cancelled in the queue is not a link, and is omitted', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const first = b.createRun('Say hello', { history: 'fresh' });
    const claim = b.claimNext(first.id);
    b.started(claim, 'manual');
    b.text(claim);
    const retracted = b.createRun('Never mind this');
    const requested = await h.store.requestCancel(retracted.id);
    expect(requested.kind).toBe('ok');
    await h.store.finishCancelled((error) => {
      throw error;
    });
    await b.end(claim, { to: 'COMPLETED' });
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'retracted');
    const event = referenceOf(h.store, child.id);
    expect(event.via).toEqual([]);
    expect(JSON.stringify(event)).not.toContain('Never mind this');
  });

  it('a never-started run that timed out in the queue is a via link with its task and the unprocessed marker', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const first = b.createRun('Say hello', { history: 'fresh' });
    const claim = b.claimNext(first.id);
    b.started(claim, 'manual');
    b.text(claim);
    const timedOut = b.createRun('Too late', { timeoutMs: 1000 });
    h.clock.advance(2000);
    expect(await h.store.expireApprovals(h.clock.now(), (error: unknown) => { throw error; })).toEqual([timedOut.id]);
    await b.end(claim, { to: 'COMPLETED' });
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'via');
    const event = referenceOf(h.store, child.id);
    expect(event.via.map((link) => link.runId)).toEqual([timedOut.id]);
    expect(event.via[0]).toMatchObject({ runId: timedOut.id, omitSeqs: [], synthesised: [] });
    expect(event.synthesised).toEqual([markerEntry(4, MARKER_TEXT.unprocessed)]);
    expect(windowOf(h, child.id).entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it('a step-0 pinned_overflow task is replaced by the dropped marker through omitSeqs and synthesised', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'Say hello', (claim) => b.text(claim), { fresh: true });
    await answeredRun(h, b, 'x'.repeat(5000), () => undefined, { ending: { to: 'FAILED', code: 'pinned_overflow' } });
    const child = await inheritingChild(h, b);
    const event = referenceOf(h.store, child.id);
    expect(event.omitSeqs).toEqual([3]);
    expect(event.synthesised).toContainEqual(markerEntry(3, MARKER_TEXT.dropped));
    assertEquivalent(h, child, 'manual', 'dropped');
  });

  it('a compaction in a later run whose cut lies inside an earlier run stops the walk at floorSeq', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'one', async (claim) => {
      await b.tool(claim);
      b.text(claim);
    }, { fresh: true });
    await answeredRun(h, b, 'two', (claim) => {
      b.text(claim);
      b.compact(claim, 3);
      b.text(claim);
    });
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'compaction across runs');
    const window = windowOf(h, child.id);
    expect(window.entries.every((entry: WindowEntry) => entry.seq > 3)).toBe(true);
    expect(window.summary?.replacedThroughSeq).toBe(3);
  });

  it('a rejected compaction item replaces the summary item', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'one', (claim) => {
      b.text(claim);
      b.text(claim);
      b.compact(claim, 2, true);
      b.text(claim);
    }, { fresh: true });
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'rejected');
    expect(windowOf(h, child.id).summary?.item).toEqual({ type: 'message', role: 'user', content: 'rejected summary through 2' });
  });

  it('a younger run truncating an older run output is applied to the older item', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    let callId = '';
    await answeredRun(h, b, 'one', async (claim) => {
      callId = await b.tool(claim, { outputChars: 3000 });
    }, { fresh: true });
    await answeredRun(h, b, 'two', (claim) => b.evict(claim, callId, 750));
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'cross-run truncation');
    expect(windowOf(h, child.id).entries).toContainEqual({ seq: 3, callId, handle: h.store.blobs.handleFor(`out ${callId} ${'o'.repeat(3000)}`), tokens: 750 });
  });

  it('an old-shape source ends the walk at its event and is read as one row', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'one', (claim) => b.text(claim), { fresh: true });
    await answeredRun(h, b, 'two', (claim) => b.text(claim), { oldShape: true });
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'old-shape source');
  });

  it('a chain of 10 references resolves without re-copying', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await answeredRun(h, b, 'run 0', (claim) => b.tool(claim, { evict: true }), { fresh: true });
    for (let index = 1; index < 10; index += 1) await answeredRun(h, b, `run ${index}`, (claim) => b.tool(claim, { evict: index % 2 === 0 }));
    const child = await inheritingChild(h, b);
    assertEquivalent(h, child, 'manual', 'chain of 10');
  });
});

describe('known difference (d) of 13.7: evicted holds only delivered ids', () => {
  it('drops an id evicted and then compacted away, which the copy kept', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    let evicted = '';
    await answeredRun(h, b, 'one', async (claim) => {
      evicted = await b.tool(claim, { evict: true });
      b.text(claim);
      b.compact(claim, 3);
      b.text(claim);
    }, { fresh: true });
    const child = await inheritingChild(h, b);
    expect(oracleState(h.store, child.id).evicted).toEqual([evicted]);
    const window = windowOf(h, child.id);
    expect(window.evicted).toEqual([]);
    expect(window.entries.map((entry) => entry.seq)).toEqual([4, 5]);
    expect(window.summary?.replacedThroughSeq).toBe(3);
  });
});

describe('R16: the backward count meets each run task seq', () => {
  const twoRuns = async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const first = await answeredRun(h, b, 'one', async (claim) => {
      b.text(claim);
      await b.tool(claim);
    }, { fresh: true });
    const child = await inheritingChild(h, b);
    return { h, first, child };
  };

  const writableEvents = (dbPath: string) => {
    const db = rawDb(dbPath);
    db.exec('DROP TRIGGER IF EXISTS events_reject_update');
    db.exec('DROP TRIGGER IF EXISTS events_reject_delete');
    return db;
  };

  it('refuses a reference whose fromNextItemSeq was corrupted as previous_run_inconsistent', async () => {
    const { h, child } = await twoRuns();
    expect(referenceOf(h.store, child.id).fromNextItemSeq).toBe(5);
    writableEvents(h.dbPath)
      .prepare("UPDATE events SET payload_json = json_set(payload_json, '$.fromNextItemSeq', 9) WHERE run_id = ? AND type = 'context.inherited'")
      .run(child.id);
    expect(() => windowOf(h, child.id)).toThrow(expect.objectContaining({ name: 'InheritanceError', code: 'previous_run_inconsistent' }));
  });

  it('refuses a source whose item-producing record is missing as previous_run_inconsistent', async () => {
    const { h, first, child } = await twoRuns();
    writableEvents(h.dbPath).prepare("DELETE FROM events WHERE run_id = ? AND type = 'tool.completed'").run(first.id);
    expect(() => windowOf(h, child.id)).toThrow(expect.objectContaining({ name: 'InheritanceError', code: 'previous_run_inconsistent' }));
  });
});
