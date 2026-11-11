import { describe, expect, it } from 'vitest';
import { MIN_ITEM_CAP, MIN_ROOM_TOKENS } from '@momonga/context';
import { proofArith } from '../support/proofs/arith.ts';
import { prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { anyCeiling, b7Goal, hypothesesSatisfiable, toolFloorOf, windowOf } from './budget-model.ts';

describe('B7: a load admitted under the tool floor leaves room for the item cap', () => {
  const z3 = useZ3();

  it('relies on MIN_ROOM_TOKENS covering two minimum item caps', () => {
    expect(MIN_ROOM_TOKENS).toBeGreaterThanOrEqual(2 * MIN_ITEM_CAP);
  });

  it(
    'proves room >= MIN_ROOM_TOKENS and MIN_ITEM_CAP <= itemCap <= floor(room/2) for F <= pinnedFloorFor, every W <= 2^33 and every ceiling <= I0',
    async () => {
      const arith = proofArith(z3.engine().api, 'B7');
      const window = windowOf(arith);
      const ceiling = anyCeiling(arith, window);
      const floor = toolFloorOf(arith, window, ceiling);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, b7Goal(arith, floor))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
