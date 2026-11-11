import { describe, expect, it } from 'vitest';
import { STORED_MODEL_KEYS, decodeStoredModel } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';
import type { Harness } from './helpers.ts';

const OLD_PINS = { modelAlias: 'local', systemPromptDigest: 'd1', toolSetDigest: 'd2', roles: { compaction: 'cheap' } };

const oldClassified = { type: 'tool.permission.classified', callId: 'call_1', subjectDigest: 'digest', outcome: 'ask', alias: 'guard', failure: 'no reply' } as unknown as RunEventPayload;

const insertOldModelChange = (h: Harness, sessionId: string): void => {
  rawDb(h.dbPath)
    .prepare("INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (NULL, ?, NULL, NULL, NULL, ?, 'model.changed', ?)")
    .run(sessionId, h.clock.now(), JSON.stringify({ type: 'model.changed', modelAlias: 'Big Model', previousModelAlias: 'local' }));
};

const withOldRun = async () => {
  const h = harness();
  const session = newSession(h.store);
  const run = await enqueue(h.store, session.id);
  const claim = mustClaim(h.store, 'w1');
  expect(h.store.append(claim, [{ type: 'run.started', attempt: claim.attempt, now: h.clock.now(), pins: { ...OLD_PINS }, mode: 'manual' }, oldClassified]).kind).toBe('ok');
  return { h, session, run, claim };
};

const payloadsOf = (h: Harness): unknown[] => rawDb(h.dbPath).prepare('SELECT id, payload_json FROM events ORDER BY id').all();

describe('events an earlier build wrote with the old model keys', () => {
  it('reads a model.changed event that holds modelAlias and previousModelAlias as stored references', () => {
    const h = harness();
    const session = newSession(h.store);
    insertOldModelChange(h, session.id);
    const changes = h.store.readModelChanges(session.id, 0);
    expect(changes.map((event) => [event.type, event.previousModel, event.model])).toEqual([['model.changed', 'local', 'Big Model']]);
    expect(h.store.readSessionEvents(session.id, 0, 10).filter((event) => event.type === 'model.changed')).toMatchObject([{ model: 'Big Model', previousModel: 'local' }]);
  });

  it('reads a run.started event whose pins hold modelAlias, and the pin decodes to the old text', async () => {
    const { h, run } = await withOldRun();
    const [started] = h.store.readRunEventsOfTypes(run.id, ['run.started']);
    if (started?.type !== 'run.started') throw new Error('the run has no run.started event');
    expect(decodeStoredModel(started.pins, STORED_MODEL_KEYS.pin)).toBe('local');
    expect(started.pins['roles']).toEqual({ compaction: 'cheap' });
  });

  it('reads a tool.permission.classified event that holds the key alias, and the model decodes to the old text', async () => {
    const { h, run } = await withOldRun();
    const [classified] = h.store.readRunEventsOfTypes(run.id, ['tool.permission.classified']);
    expect(classified).toBeDefined();
    expect(decodeStoredModel(classified as unknown as Record<string, unknown>, STORED_MODEL_KEYS.classified)).toBe('guard');
  });

  it('lists a terminal run that holds such events for a facts rebuild, and its events are read without an error', async () => {
    const { h, run, claim } = await withOldRun();
    insertOldModelChange(h, run.sessionId);
    expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    expect(h.store.runFacts.cursor().afterEventId).toBe(0);
    expect(h.store.runFacts.nextBatch(10).runIds).toEqual([run.id]);
    expect(h.store.readRunEvents(run.id, 0, 100).map((event) => event.type)).toContain('run.started');
    expect(() => h.store.readSessionEvents(run.sessionId, 0, 100)).not.toThrow();
  });

  it('rewrites no row when the old events are read', async () => {
    const { h, run } = await withOldRun();
    insertOldModelChange(h, run.sessionId);
    const before = payloadsOf(h);
    h.store.readModelChanges(run.sessionId, 0);
    h.store.readRunEvents(run.id, 0, 100);
    h.store.readSessionEvents(run.sessionId, 0, 100);
    expect(payloadsOf(h)).toEqual(before);
    expect(JSON.stringify(before)).toContain('modelAlias');
  });
});
