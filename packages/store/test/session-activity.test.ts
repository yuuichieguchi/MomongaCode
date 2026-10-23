import { describe, expect, it } from 'vitest';
import { START_MS, cancel, enqueue, harness, mustClaim, newSession } from './helpers.ts';

describe('sessionActivity', () => {
  it('lastActivityAt is the newest session event created_at', () => {
    const { clock, store } = harness();
    const session = newSession(store);
    clock.advance(100);
    enqueue(store, session.id, 'first');
    clock.advance(250);
    const result = store.setPermissionMode(session.id, 'plan');
    if (result.kind !== 'ok') throw new Error('expected the mode change to apply');

    expect(store.sessionActivity(session.id)).toEqual({ lastActivityAt: START_MS + 350, hasActiveRun: true });
  });

  it('ignores events of other sessions', () => {
    const { clock, store } = harness();
    const quiet = newSession(store, '/work/quiet');
    const busy = newSession(store, '/work/busy');
    clock.advance(500);
    enqueue(store, busy.id, 'busy');

    expect(store.sessionActivity(quiet.id)).toEqual({ lastActivityAt: START_MS, hasActiveRun: false });
  });

  it('falls back to the session createdAt', () => {
    const { clock, store } = harness();
    clock.advance(42);
    const session = newSession(store);
    clock.advance(1000);

    expect(store.sessionActivity(session.id)).toEqual({ lastActivityAt: START_MS + 42, hasActiveRun: false });
  });

  it('hasActiveRun tracks non-terminal runs', () => {
    const { store } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id, 'work');
    expect(store.sessionActivity(session.id)?.hasActiveRun).toBe(true);

    const claim = mustClaim(store, 'worker-1');
    expect(claim.runId).toBe(run.id);
    expect(store.sessionActivity(session.id)?.hasActiveRun).toBe(true);

    const completed = store.transition(claim, ['RUNNING'], 'COMPLETED');
    if (completed.kind !== 'ok') throw new Error(`expected COMPLETED, got ${completed.kind}`);
    expect(store.sessionActivity(session.id)?.hasActiveRun).toBe(false);

    const queued = enqueue(store, session.id, 'again');
    expect(store.sessionActivity(session.id)?.hasActiveRun).toBe(true);
    expect(cancel(store, queued.id).status).toBe('CANCELLED');
    expect(store.sessionActivity(session.id)?.hasActiveRun).toBe(false);
  });

  it('undefined for an unknown session', () => {
    const { store } = harness();
    expect(store.sessionActivity('no-such-session')).toBeUndefined();
  });
});
