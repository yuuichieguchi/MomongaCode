import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { enqueue, harness, mustClaim, newSession } from './helpers.ts';

describe('the /compact request in the journal', () => {
  it('round-trips the store with its instructions and adds no item to the history', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id, 'go');
    const claim = mustClaim(store, 'w1');
    const before = store.readRunEvents(run.id, 0, 1000);
    expect(store.append(claim, [{ type: 'user.compact', instructions: 'keep the test names' }, { type: 'user.compact' }]).kind).toBe('ok');
    const events = store.readRunEvents(run.id, 0, 1000);
    expect(events.filter((event) => event.type === 'user.compact').map((event) => (event.type === 'user.compact' ? event.instructions : 'other'))).toEqual(['keep the test names', undefined]);
    const fence = store.getSession(run.sessionId)?.fenceNonce ?? '';
    const fold = (list: typeof events) => list.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId, fence }));
    expect(fold(events).history).toEqual(fold(before).history);
  });
});
