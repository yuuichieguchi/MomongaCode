import { describe, expect, it } from 'vitest';
import { MARGIN, MIN_MARGIN } from '@momonga/protocol';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofBool, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { MAX_WINDOW, ceilOf, hypothesesSatisfiable, named, windowOf } from './budget-model.ts';
import type { Window } from './budget-model.ts';

type TwoWindows = { readonly alias: Window; readonly Wt: ProofInt; readonly targetMargin: ProofInt };

const twoWindowsOf = (arith: ProofArith): TwoWindows => {
  const { ctx } = arith;
  const alias = windowOf(arith);
  arith.given(alias.W.sub(alias.R).ge(alias.margin));
  const Wt = arith.int('Wt');
  arith.given(Wt.ge(1), Wt.le(ctx.Int.val(MAX_WINDOW)));
  const targetMargin = named(arith, 'targetMargin', arith.max(ceilOf(arith, MARGIN, Wt), ctx.Int.val(MIN_MARGIN)));
  return { alias, Wt, targetMargin };
};

const fitsTargetWindow = ({ alias, Wt, targetMargin }: TwoWindows): ProofBool =>
  alias.I0.add(targetMargin).le(Wt.sub(alias.R));

describe('B10: a fallback target checked against the alias window fits its own window', () => {
  const z3 = useZ3();

  it(
    'B10 I0(W_a) + marginFloorFor(W_t) <= W_t - R(W_a, maxOutput) for every W_a <= W_t <= 2^33 in the B8 domain',
    async () => {
      const arith = proofArith(z3.engine().api, 'B10');
      const windows = twoWindowsOf(arith);
      arith.given(windows.alias.W.le(windows.Wt));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, fitsTargetWindow(windows))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B10 evidence: is refuted when W_t < W_a',
    async () => {
      const arith = proofArith(z3.engine().api, 'B10-evidence');
      const windows = twoWindowsOf(arith);
      arith.given(windows.Wt.lt(windows.alias.W));
      const model = await expectRefuted(arith, fitsTargetWindow(windows));
      expect(BigInt(String(model.Wt))).toBeLessThan(BigInt(String(model.W)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  const compositionOf = (arith: ProofArith, admitted: boolean): { readonly windows: TwoWindows; readonly server: ProofInt } => {
    const windows = twoWindowsOf(arith);
    arith.given(windows.alias.W.le(windows.Wt));
    const c = arith.int('c');
    const under = arith.int('under');
    const server = arith.int('server');
    arith.given(c.ge(0), under.ge(0), server.le(c.add(under).add(windows.targetMargin)));
    if (admitted) arith.given(c.add(under).le(windows.alias.I0));
    return { windows, server };
  };

  it(
    'B10 composition with B8 (i): server <= c + under + marginFloorFor(W_t) and c + under <= I0(W_a) give server <= W_t - R',
    async () => {
      const arith = proofArith(z3.engine().api, 'B10-composition');
      const { windows, server } = compositionOf(arith, true);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, server.le(windows.Wt.sub(windows.alias.R)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B10 composition evidence: is refuted without c + under <= I0(W_a)',
    async () => {
      const arith = proofArith(z3.engine().api, 'B10-composition-evidence');
      const { windows, server } = compositionOf(arith, false);
      const model = await expectRefuted(arith, server.le(windows.Wt.sub(windows.alias.R)));
      expect(BigInt(String(model.c)) + BigInt(String(model.under))).toBeGreaterThan(BigInt(String(model.I0)));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
