import { describe, expect, it } from 'vitest';
import { JournalThreadError } from '@momonga/store';
import { dispositionOf } from '../../src/worker/gateway-policy.ts';

describe('the retry rule for a journal thread failure (O2)', () => {
  it('requeues with no refund and no wait, so the attempt budget bounds the retries', () => {
    expect(dispositionOf(new JournalThreadError('the journal thread exited'), 0)).toEqual({ kind: 'requeue', refund: false, retryAfterMs: 0, interrupted: false });
  });

  it('does not depend on how many stream interruptions came before', () => {
    expect(dispositionOf(new JournalThreadError('the journal thread exited'), 7)).toEqual({ kind: 'requeue', refund: false, retryAfterMs: 0, interrupted: false });
  });
});
