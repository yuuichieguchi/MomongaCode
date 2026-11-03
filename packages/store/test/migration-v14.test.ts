import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const requested = (step: number, pinnedDigest?: string): RunEventPayload =>
  ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, ...(pinnedDigest === undefined ? {} : { pinnedDigest }), body: { model: 'fm', input: [] } }) as RunEventPayload;

describe('migration v14', () => {
  it('copies the pinned-layer digest of a recorded request into the events column and leaves other events without one', () => {
    const h = harness();
    enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const digest = 'c'.repeat(64);

    expect(h.store.append(claim, [requested(1, digest), requested(2), { type: 'user.message', text: 'hi' }]).kind).toBe('ok');

    const rows = rawDb(h.dbPath).prepare('SELECT type, pinned_digest FROM events WHERE type IN (\'model.requested\', \'user.message\') ORDER BY seq').all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { type: 'user.message', pinned_digest: null },
      { type: 'model.requested', pinned_digest: digest },
      { type: 'model.requested', pinned_digest: null },
      { type: 'user.message', pinned_digest: null },
    ]);
  });
});
