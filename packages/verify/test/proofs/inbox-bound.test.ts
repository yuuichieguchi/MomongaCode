import { describe, expect, it } from 'vitest';
import { INBOX_MAX_PENDING } from '@momonga/protocol';
import type { InboxRow } from '@momonga/store';
import { proofArith } from '../support/proofs/arith.ts';
import { prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { TIMEOUT_MS, enqueue, harness, newSession } from '../../../store/test/helpers.ts';

const TERMS = { timeoutMs: TIMEOUT_MS, limits: { maxSteps: 10 }, pins: {} };

const nextPending = (pending: number, step: 'add' | 'withdraw'): number => (step === 'add' ? (pending >= INBOX_MAX_PENDING ? pending : pending + 1) : Math.max(0, pending - 1));

describe('inbox bound (design/cli-tui.md section 15.4): the pending rows of a session, under the guard of the store inbox (packages/store/src/runtime-store.ts)', () => {
  const z3 = useZ3();

  it('reads the store at a sequence of adds and withdrawals, so the transition below is the store and not itself', async () => {
    const h = harness();
    const session = newSession(h.store);
    await enqueue(h.store, session.id);
    const rows: InboxRow[] = [];
    let pending = 0;
    const steps = [...Array.from({ length: INBOX_MAX_PENDING + 3 }, () => 'add' as const), 'withdraw', 'withdraw', 'add', 'add', 'add'] as const;
    for (const step of steps) {
      if (step === 'add') {
        const result = await h.store.inbox.add(session.id, { delivery: 'queue', text: `m${rows.length}`, run: TERMS });
        if (result.kind === 'added') rows.push(result.row);
        else expect(result).toEqual({ kind: 'full' });
      } else {
        const row = rows.shift();
        if (row === undefined) throw new Error('no row to withdraw');
        expect(h.store.inbox.withdraw(row.id)).toMatchObject({ kind: 'withdrawn' });
      }
      pending = nextPending(pending, step);
      expect(h.store.inbox.list(session.id)).toHaveLength(pending);
    }
  });

  it(
    'never holds more than INBOX_MAX_PENDING pending rows, for any counts of add and withdraw',
    async () => {
      const arith = proofArith(z3.engine().api, 'inbox-bound');
      const { ctx } = arith;
      const pending = arith.int('pending');
      arith.given(pending.ge(0), pending.le(INBOX_MAX_PENDING));
      const added = ctx.If(pending.ge(INBOX_MAX_PENDING), pending, pending.add(1));
      const withdrawn = arith.max(ctx.Int.val(0), pending.sub(1));
      const goal = ctx.And(added.ge(0), added.le(INBOX_MAX_PENDING), withdrawn.ge(0), withdrawn.le(INBOX_MAX_PENDING));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
