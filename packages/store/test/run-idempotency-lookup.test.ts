import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { sameRunRequest } from '@momonga/store';
import { TIMEOUT_MS, enqueue, harness, newSession } from './helpers.ts';

const digestOf = (input: string): string => sha256Hex(canonicalJson({ input }));

const createWith = (store: ReturnType<typeof harness>['store'], sessionId: string, key: string, requestDigest: string | undefined) =>
  store.createRunAndEnqueue(sessionId, {
    input: 'hello',
    idempotencyKey: key,
    ...(requestDigest === undefined ? {} : { requestDigest }),
    timeoutMs: TIMEOUT_MS,
    limits: { maxSteps: 10 },
    pins: { model: 'fm' },
  });

describe('findRunByIdempotencyKey', () => {
  it('findRunByIdempotencyKey returns the run and request digest', () => {
    const { store } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id, 'hello', 'key-1');

    const found = store.findRunByIdempotencyKey(session.id, 'key-1');

    expect(found).toEqual({ run: store.getRun(run.id), requestDigest: digestOf('hello') });
  });

  it('returns a null request digest for a run created without one', () => {
    const { store } = harness();
    const session = newSession(store);
    const created = createWith(store, session.id, 'key-null', undefined);
    if (created.kind !== 'created') throw new Error(`expected created, got ${created.kind}`);

    expect(store.findRunByIdempotencyKey(session.id, 'key-null')).toEqual({ run: created.run, requestDigest: null });
  });

  it('returns undefined for an unknown key or another session\'s key', () => {
    const { store } = harness();
    const first = newSession(store, '/work/a');
    const second = newSession(store, '/work/b');
    enqueue(store, first.id, 'hello', 'key-1');

    expect(store.findRunByIdempotencyKey(first.id, 'key-unknown')).toBeUndefined();
    expect(store.findRunByIdempotencyKey(second.id, 'key-1')).toBeUndefined();
    expect(store.findRunByIdempotencyKey('no-such-session', 'key-1')).toBeUndefined();
  });
});

describe('sameRunRequest', () => {
  it('matches only an equal non-null digest', () => {
    expect(sameRunRequest({ requestDigest: 'd1' }, 'd1')).toBe(true);
    expect(sameRunRequest({ requestDigest: 'd1' }, 'd2')).toBe(false);
    expect(sameRunRequest({ requestDigest: 'd1' }, undefined)).toBe(false);
    expect(sameRunRequest({ requestDigest: null }, undefined)).toBe(false);
    expect(sameRunRequest({ requestDigest: null }, 'd1')).toBe(false);
  });

  it('sameRunRequest agrees with createRunAndEnqueue for equal, different and null digests', () => {
    const { store } = harness();
    const session = newSession(store);
    const cases: Array<{ key: string; stored: string | undefined; replayed: string | undefined }> = [
      { key: 'equal', stored: 'digest-a', replayed: 'digest-a' },
      { key: 'different', stored: 'digest-a', replayed: 'digest-b' },
      { key: 'missing-replay', stored: 'digest-a', replayed: undefined },
      { key: 'null-stored', stored: undefined, replayed: undefined },
      { key: 'null-stored-replayed', stored: undefined, replayed: 'digest-a' },
    ];
    const verdicts = cases.map(({ key, stored, replayed }) => {
      createWith(store, session.id, key, stored);
      const found = store.findRunByIdempotencyKey(session.id, key);
      if (found === undefined) throw new Error(`run for ${key} not found`);
      const replay = createWith(store, session.id, key, replayed);
      return { key, predicate: sameRunRequest(found, replayed), store: replay.kind };
    });

    expect(verdicts).toEqual([
      { key: 'equal', predicate: true, store: 'existing' },
      { key: 'different', predicate: false, store: 'key_reused' },
      { key: 'missing-replay', predicate: false, store: 'key_reused' },
      { key: 'null-stored', predicate: false, store: 'key_reused' },
      { key: 'null-stored-replayed', predicate: false, store: 'key_reused' },
    ]);
  });
});
