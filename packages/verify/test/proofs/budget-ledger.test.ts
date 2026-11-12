import { describe, expect, it } from 'vitest';
import { proofArith } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { hypothesesSatisfiable, ledgerOf, releasedBeforeAppend, settledAtomically } from './budget-model.ts';

describe('tree conservation of the budget ledger (BudgetLedger.tla, B2)', () => {
  const z3 = useZ3();

  it(
    'keeps spent plus reserved within the limit when the write that records the spend clears the reservation, whatever another run admits after it',
    async () => {
      const arith = proofArith(z3.engine().api, 'B2-atomic');
      const goal = settledAtomically(arith, ledgerOf(arith));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'breaks the limit when the reservation is released before the spend is appended and another run admits in between (store-protocol-03)',
    async () => {
      const arith = proofArith(z3.engine().api, 'B2-release-before-append');
      const goal = releasedBeforeAppend(arith, ledgerOf(arith));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, goal);
      const value = (name: string): bigint => BigInt(model[name] as string);
      expect(value('cost')).toBeGreaterThan(0n);
      expect(value('spent') + value('cost') + value('others') + value('admitted')).toBeGreaterThan(value('limit'));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
