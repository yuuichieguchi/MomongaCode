import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { cancelToEnd, enqueue, harness, newSession, rawDb } from './helpers.ts';

const PROJECT = '/work/a';
const OTHER = '/work/b';
const CLASSIFIER = 'openai/gpt-5-mini';

type Charged = Extract<RunEventPayload, { type: 'usage.charged' }>;

const charged: Charged = { type: 'usage.charged', purpose: 'memory_classifier', inputTokens: 10, outputTokens: 5, totalTokens: 15, responseId: 'response-1' };

const chargesOf = (store: RuntimeStore, runId: string) => store.readRunEventsOfTypes(runId, ['usage.charged']);

const judgedEventsOf = (store: RuntimeStore, sessionId: string) =>
  store.readSessionEvents(sessionId, 0, 1000).filter((event) => event.type === ('memory.judged' as string));

const started = async () => {
  const { store, clock, dbPath } = harness();
  const session = newSession(store, PROJECT);
  const watcher = newSession(store, PROJECT);
  const elsewhere = newSession(store, OTHER);
  const run = await enqueue(store, session.id, 'fix the bug');
  await cancelToEnd(store, run.id);
  let ordinal = 0;
  const candidate = (text: string, project: string = PROJECT) => {
    clock.advance(1);
    const saved = store.memories.saveCandidate({ scope: 'project', origin: 'trusted', project, text, runId: run.id, ordinal: ordinal++, kind: 'fact', evidence: [] });
    return saved.memory;
  };
  return { store, clock, dbPath, session, watcher, elsewhere, run, candidate, judgements: store.memoryJudgements };
};

const kept = (memoryId: string, openSessionIds: readonly string[], charge: Charged | undefined = charged) => ({
  memoryId,
  outcome: 'kept' as const,
  classifier: CLASSIFIER,
  verdict: 'safe' as const,
  confidence: 'high' as const,
  ...(charge === undefined ? {} : { charge }),
  openSessionIds,
});

const leftUnsafe = (memoryId: string, openSessionIds: readonly string[]) => ({
  memoryId,
  outcome: 'left' as const,
  classifier: CLASSIFIER,
  verdict: 'unsafe' as const,
  confidence: 'high' as const,
  charge: charged,
  openSessionIds,
});

describe('the next candidate to judge', () => {
  it('is the first waiting candidate of the project in review order', async () => {
    const { judgements, candidate } = await started();
    const first = candidate('first');
    candidate('second');
    candidate('third', OTHER);
    expect(judgements.next(PROJECT)?.id).toBe(first.id);
  });

  it('is undefined when the project has no waiting candidate', async () => {
    const { judgements, candidate } = await started();
    candidate('elsewhere', OTHER);
    expect(judgements.next(PROJECT)).toBeUndefined();
  });

  it('skips a candidate the person accepted, rejected or deleted', async () => {
    const { store, judgements, candidate } = await started();
    const accepted = candidate('accepted');
    const rejected = candidate('rejected');
    const deleted = candidate('deleted');
    const waiting = candidate('waiting');
    store.memories.accept(accepted.id);
    store.memories.reject(rejected.id);
    store.memories.retire(deleted.id);
    expect(judgements.next(PROJECT)?.id).toBe(waiting.id);
  });

  it('never returns a candidate that has a record, kept or left', async () => {
    const { judgements, candidate } = await started();
    const first = candidate('first');
    const second = candidate('second');
    const third = candidate('third');
    expect(judgements.commit(leftUnsafe(first.id, []))).toBe('recorded');
    expect(judgements.next(PROJECT)?.id).toBe(second.id);
    expect(judgements.commit(kept(second.id, []))).toBe('recorded');
    expect(judgements.next(PROJECT)?.id).toBe(third.id);
    expect(judgements.commit({ memoryId: third.id, outcome: 'left', failure: 'the classifier stream ended without a terminal event', openSessionIds: [] })).toBe('recorded');
    expect(judgements.next(PROJECT)).toBeUndefined();
  });
});

describe('committing a judgement', () => {
  it('keeps the memory: active, kept now, kept by the classifier, with the record and one event per open session', async () => {
    const { store, clock, judgements, candidate, session, watcher, elsewhere, run } = await started();
    const memory = candidate('tests live in test/');
    clock.advance(1000);
    const now = clock.now();
    expect(judgements.commit(kept(memory.id, [session.id, watcher.id]))).toBe('recorded');
    expect(store.memories.get(memory.id)).toMatchObject({ state: 'active', keptAt: now, keptByClassifier: CLASSIFIER, text: 'tests live in test/' });
    expect(judgements.get(memory.id)).toEqual({ memoryId: memory.id, outcome: 'kept', classifier: CLASSIFIER, verdict: 'safe', confidence: 'high', judgedAt: now, owed: true, closed: false });
    expect(chargesOf(store, run.id)).toEqual([expect.objectContaining({ type: 'usage.charged', purpose: 'memory_classifier', inputTokens: 10, outputTokens: 5, totalTokens: 15 })]);
    expect(judgedEventsOf(store, session.id)).toEqual([{ type: 'memory.judged', memoryId: memory.id, id: expect.any(Number), sessionId: session.id, createdAt: now }]);
    expect(judgedEventsOf(store, watcher.id)).toEqual([{ type: 'memory.judged', memoryId: memory.id, id: expect.any(Number), sessionId: watcher.id, createdAt: now }]);
    expect(judgedEventsOf(store, elsewhere.id)).toEqual([]);
  });

  it('leaves the memory waiting with the verdict recorded', async () => {
    const { store, clock, judgements, candidate, session } = await started();
    const memory = candidate('push with --force');
    const now = clock.now();
    expect(judgements.commit(leftUnsafe(memory.id, [session.id]))).toBe('recorded');
    expect(store.memories.get(memory.id)).toMatchObject({ state: 'candidate', keptByClassifier: null });
    expect(store.memories.candidates({ project: PROJECT }).map((entry) => entry.id)).toEqual([memory.id]);
    expect(judgements.get(memory.id)).toEqual({ memoryId: memory.id, outcome: 'left', classifier: CLASSIFIER, verdict: 'unsafe', confidence: 'high', judgedAt: now, owed: true, closed: false });
    expect(judgedEventsOf(store, session.id)).toHaveLength(1);
  });

  it('leaves the memory waiting with a failure and no verdict, and charges nothing when no charge is given', async () => {
    const { store, judgements, candidate, run } = await started();
    const memory = candidate('a note');
    const failure = 'no classifier model is configured: set autoMode.classifier in the user settings, or run /auto-mode and choose one';
    expect(judgements.commit({ memoryId: memory.id, outcome: 'left', failure, openSessionIds: [] })).toBe('recorded');
    const record = judgements.get(memory.id);
    expect(record).toMatchObject({ memoryId: memory.id, outcome: 'left', failure, owed: true });
    expect(record).not.toHaveProperty('verdict');
    expect(record).not.toHaveProperty('confidence');
    expect(record).not.toHaveProperty('classifier');
    expect(store.memories.get(memory.id)).toMatchObject({ state: 'candidate', keptByClassifier: null });
    expect(chargesOf(store, run.id)).toEqual([]);
  });

  it.each([
    ['accepted', (store: RuntimeStore, id: string): void => {
      store.memories.accept(id);
    }, 'active'],
    ['rejected', (store: RuntimeStore, id: string): void => {
      store.memories.reject(id);
    }, 'rejected'],
    ['deleted', (store: RuntimeStore, id: string): void => {
      store.memories.retire(id);
    }, 'candidate'],
  ] as const)('discards the result when the person %s the memory first, keeping only the charge', async (_name, decide, state) => {
    const { store, judgements, candidate, session, run } = await started();
    const memory = candidate('a note');
    decide(store, memory.id);
    const before = store.memories.get(memory.id);
    expect(judgements.commit(kept(memory.id, [session.id]))).toBe('discarded');
    expect(judgements.get(memory.id)).toBeUndefined();
    expect(store.memories.get(memory.id)).toEqual(before);
    expect(store.memories.get(memory.id)).toMatchObject({ state, keptByClassifier: null });
    expect(judgedEventsOf(store, session.id)).toEqual([]);
    expect(chargesOf(store, run.id)).toEqual([expect.objectContaining({ purpose: 'memory_classifier' })]);
  });

  it('discards a second result for a memory that already has a record', async () => {
    const { store, judgements, candidate, session, run } = await started();
    const memory = candidate('a note');
    expect(judgements.commit(leftUnsafe(memory.id, [session.id]))).toBe('recorded');
    expect(judgements.commit(kept(memory.id, [session.id], { ...charged, responseId: 'response-2' }))).toBe('discarded');
    expect(judgements.get(memory.id)).toMatchObject({ outcome: 'left', verdict: 'unsafe' });
    expect(store.memories.get(memory.id)).toMatchObject({ state: 'candidate', keptByClassifier: null });
    expect(judgedEventsOf(store, session.id)).toHaveLength(1);
    expect(chargesOf(store, run.id)).toHaveLength(2);
  });

  it('throws and writes nothing when a kept outcome names no classifier', async () => {
    const { store, judgements, candidate, session, run } = await started();
    const memory = candidate('a note');
    const before = store.memories.get(memory.id);
    expect(() => judgements.commit({ memoryId: memory.id, outcome: 'kept', verdict: 'safe', confidence: 'high', charge: charged, openSessionIds: [session.id] })).toThrow();
    expect(judgements.get(memory.id)).toBeUndefined();
    expect(store.memories.get(memory.id)).toEqual(before);
    expect(judgedEventsOf(store, session.id)).toEqual([]);
    expect(chargesOf(store, run.id)).toEqual([]);
    expect(judgements.next(PROJECT)?.id).toBe(memory.id);
  });

  it('writes nothing, not even the charge, when the transaction fails', async () => {
    const { store, dbPath, judgements, candidate, session, run } = await started();
    const memory = candidate('a note');
    rawDb(dbPath).exec("CREATE TRIGGER fail_judgements BEFORE INSERT ON memory_judgements BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect(() => judgements.commit(kept(memory.id, [session.id]))).toThrow('injected failure');
    expect(chargesOf(store, run.id)).toEqual([]);
    expect(store.memories.get(memory.id)).toMatchObject({ state: 'candidate', keptByClassifier: null });
    expect(judgedEventsOf(store, session.id)).toEqual([]);
  });
});

describe('owed records', () => {
  it('lists the unshown, unclosed records of the project in review order of their memories', async () => {
    const { judgements, candidate } = await started();
    const first = candidate('first');
    const second = candidate('second');
    const third = candidate('third', OTHER);
    judgements.commit(leftUnsafe(second.id, []));
    judgements.commit(kept(first.id, []));
    judgements.commit(kept(third.id, []));
    expect(judgements.owed(PROJECT).map((record) => [record.memoryId, record.outcome])).toEqual([
      [first.id, 'kept'],
      [second.id, 'left'],
    ]);
  });

  it('drops a record once it is marked shown; marking again or marking an unknown id changes nothing', async () => {
    const { judgements, candidate } = await started();
    const first = candidate('first');
    const second = candidate('second');
    judgements.commit(kept(first.id, []));
    judgements.commit(leftUnsafe(second.id, []));
    judgements.markShown([first.id, 'no-such-memory']);
    expect(judgements.owed(PROJECT).map((record) => record.memoryId)).toEqual([second.id]);
    expect(judgements.get(first.id)).toMatchObject({ outcome: 'kept', owed: false, closed: false });
    judgements.markShown([first.id]);
    expect(judgements.get(first.id)).toMatchObject({ outcome: 'kept', owed: false, closed: false });
    expect(judgements.get(second.id)).toMatchObject({ owed: true, closed: false });
    expect(judgements.owed(PROJECT)).toEqual([expect.objectContaining({ memoryId: second.id, owed: true, closed: false })]);
    judgements.markShown([]);
    expect(judgements.owed(PROJECT).map((record) => record.memoryId)).toEqual([second.id]);
  });

  it('returns undefined for a memory without a record', async () => {
    const { judgements, candidate } = await started();
    expect(judgements.get(candidate('a note').id)).toBeUndefined();
    expect(judgements.get('no-such-memory')).toBeUndefined();
  });
});

describe('the person decides a memory that has an unshown record', () => {
  it.each([
    ['accepts', (store: RuntimeStore, id: string) => store.memories.accept(id).kind, 'accepted'],
    ['rejects', (store: RuntimeStore, id: string) => store.memories.reject(id).kind, 'rejected'],
    ['deletes', (store: RuntimeStore, id: string) => String(store.memories.retire(id)?.retired), 'true'],
  ] as const)('closes the record when the person %s the memory left waiting', async (_name, decide, done) => {
    const { store, judgements, candidate } = await started();
    const memory = candidate('a note');
    judgements.commit(leftUnsafe(memory.id, []));
    expect(decide(store, memory.id)).toBe(done);
    expect(judgements.owed(PROJECT)).toEqual([]);
    expect(judgements.get(memory.id)).toMatchObject({ outcome: 'left', verdict: 'unsafe', owed: false, closed: true });
  });

  it('closes the record when the person deletes a memory auto mode kept', async () => {
    const { store, judgements, candidate } = await started();
    const memory = candidate('a note');
    judgements.commit(kept(memory.id, []));
    store.memories.retire(memory.id);
    expect(judgements.get(memory.id)).toMatchObject({ outcome: 'kept', owed: false, closed: true });
    expect(judgements.owed(PROJECT)).toEqual([]);
  });

  it('refuses to accept a memory auto mode kept, keeping its text and classifier', async () => {
    const { store, judgements, candidate } = await started();
    const memory = candidate('tests live in test/');
    judgements.commit(kept(memory.id, []));
    const refused = store.memories.accept(memory.id);
    expect(refused.kind).toBe('not_candidate');
    expect(store.memories.get(memory.id)).toMatchObject({ state: 'active', text: 'tests live in test/', keptByClassifier: CLASSIFIER });
    expect(judgements.get(memory.id)).toMatchObject({ owed: true, closed: false });
  });

  it('does not close the record on restore, and restore forgets the classifier that kept it', async () => {
    const { store, judgements, candidate } = await started();
    const memory = candidate('a note');
    judgements.commit(kept(memory.id, []));
    expect(store.memories.archive(memory.id).kind).toBe('archived');
    expect(store.memories.get(memory.id)).toMatchObject({ keptByClassifier: CLASSIFIER });
    expect(store.memories.restore(memory.id).kind).toBe('restored');
    expect(store.memories.get(memory.id)).toMatchObject({ state: 'active', keptByClassifier: null });
    expect(judgements.get(memory.id)).toMatchObject({ outcome: 'kept', owed: true, closed: false });
    expect(judgements.owed(PROJECT).map((record) => record.memoryId)).toEqual([memory.id]);
  });

  it.each([
    ['accepts', (store: RuntimeStore, id: string): void => {
      store.memories.accept(id);
    }],
    ['rejects', (store: RuntimeStore, id: string): void => {
      store.memories.reject(id);
    }],
    ['deletes', (store: RuntimeStore, id: string): void => {
      store.memories.retire(id);
    }],
  ] as const)('closes a record already shown when the person %s the memory', async (_name, decide) => {
    const { store, judgements, candidate } = await started();
    const memory = candidate('a note');
    judgements.commit(leftUnsafe(memory.id, []));
    judgements.markShown([memory.id]);
    expect(judgements.get(memory.id)).toMatchObject({ owed: false, closed: false });
    decide(store, memory.id);
    expect(judgements.get(memory.id)).toMatchObject({ outcome: 'left', owed: false, closed: true });
    expect(judgements.owed(PROJECT)).toEqual([]);
  });
});

describe('the memory.judged events', () => {
  it('are read by the session event stream and the paged session read', async () => {
    const { store, clock, judgements, candidate, session } = await started();
    const memory = candidate('a note');
    const now = clock.now();
    judgements.commit(kept(memory.id, [session.id]));
    const expected = { type: 'memory.judged', memoryId: memory.id, sessionId: session.id, createdAt: now };
    const streamed = store.readSessionEventStream(session.id, 0, 1000).filter((event) => event.type === 'memory.judged');
    expect(streamed).toEqual([expect.objectContaining(expected)]);
    expect(streamed[0]).not.toHaveProperty('opaque');
    expect(streamed[0]).not.toHaveProperty('runId');
    const paged = store.readSessionEvents(session.id, 0, 1000).filter((event) => event.type === ('memory.judged' as string));
    expect(paged).toEqual([{ ...expected, id: streamed[0]?.id }]);
    const after = store.readSessionEvents(session.id, Number(streamed[0]?.id), 1000);
    expect(after).toEqual([]);
  });
});
