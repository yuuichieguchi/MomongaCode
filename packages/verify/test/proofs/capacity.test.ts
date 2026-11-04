import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR } from '@momonga/protocol';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ErrorBound, ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import {
  b1Goal,
  b2FitGoal,
  b2StepGoal,
  b4Goal,
  b7Goal,
  ceilOf,
  hypothesesSatisfiable,
  marksOf,
  named,
  toolFloorOf,
  windowOf,
} from './budget-model.ts';
import type { Ratio, Window } from './budget-model.ts';

const QUANTUM = 2 ** 20;

type Shape = { readonly label: string; readonly ratio: () => Ratio; readonly minimum: number };

const shapes: readonly Shape[] = [
  { label: 'exact', ratio: () => ({ num: 0, den: 1 }), minimum: 0 },
  { label: 'estimated without a configured ratio', ratio: () => ESTIMATED_ERROR, minimum: 1 },
  { label: 'estimated with configured ratio 1/2^20', ratio: () => ({ num: 1, den: QUANTUM }), minimum: 1 },
  { label: 'estimated with configured ratio 2^20/2^20', ratio: () => ({ num: QUANTUM, den: QUANTUM }), minimum: 1 },
  { label: 'calibrated with ratio 314573/2^20, configured or written by the probe', ratio: () => ({ num: 314_573, den: QUANTUM }), minimum: 1 },
  { label: 'calibrated with ratio 1/2^20, configured or written by the probe', ratio: () => ({ num: 1, den: QUANTUM }), minimum: 1 },
  { label: 'exact with configured ratio 1/2^20 and the exact minimum 0', ratio: () => ({ num: 1, den: QUANTUM }), minimum: 0 },
  { label: 'exact with configured ratio 314573/2^20 and the exact minimum 0', ratio: () => ({ num: 314_573, den: QUANTUM }), minimum: 0 },
  { label: 'exact with configured ratio 2^20/2^20 and the exact minimum 0', ratio: () => ({ num: QUANTUM, den: QUANTUM }), minimum: 0 },
];

const shapeAt = (arith: ProofArith, shape: Shape, point: ProofInt): ProofInt => {
  const { ctx } = arith;
  const zero = ctx.Int.val(0);
  return ctx.If(point.eq(zero), zero, arith.max(ctx.Int.val(shape.minimum), ceilOf(arith, shape.ratio(), point))) as ProofInt;
};

const largestFitting = (arith: ProofArith, window: Window, name: string, under: (point: ProofInt) => ProofInt): ProofInt => {
  const capacity = arith.int(name);
  const next = capacity.add(1);
  arith.given(capacity.ge(0), capacity.add(under(capacity)).le(window.I0), next.add(under(next)).gt(window.I0));
  return capacity;
};

const sizedCeiling = (arith: ProofArith, window: Window, ratio: Ratio): ProofInt =>
  arith.floorDiv(window.I0.mul(arith.ctx.Int.val(BigInt(ratio.den))), BigInt(ratio.den + ratio.num));

const observedCapacity = (arith: ProofArith, window: Window, under: ErrorBound): ProofInt => {
  const C = largestFitting(arith, window, 'C', (point) => under.at(point));
  return C;
};

describe('B9: the observed capacity C', () => {
  const z3 = useZ3();

  it.each(shapes.map((shape) => [shape.label, shape] as const))(
    'with nothing reported and no image, C_t = floor(I0 / (1 + sizingRatio)) for %s counting',
    async (_label, shape) => {
      const arith = proofArith(z3.engine().api, `B9-${shape.label}`);
      const window = windowOf(arith);
      const capacity = largestFitting(arith, window, 'C', (point) => shapeAt(arith, shape, point));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, capacity.eq(sizedCeiling(arith, window, shape.ratio())))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'evidence: the earlier rule "an exact reply stays exact" gives C_t = I0 for an exact target with configured ratio 314573/2^20, refuting equality with floor(I0 / (1 + sizingRatioFor))',
    async () => {
      const arith = proofArith(z3.engine().api, 'B9-exact-stays-exact');
      const window = windowOf(arith);
      const capacity = named(arith, 'C', window.I0);
      const sized = named(arith, 'sized', sizedCeiling(arith, window, { num: 314_573, den: QUANTUM }));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, capacity.eq(sized));
      expect(BigInt(model.C as string)).toBeGreaterThan(BigInt(model.sized as string));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  const aliasPairs: ReadonlyArray<readonly [Shape, Shape, Ratio]> = [
    [shapes[0] as Shape, shapes[1] as Shape, { num: 3, den: 10 }],
    [shapes[1] as Shape, shapes[4] as Shape, { num: 314_573, den: QUANTUM }],
    [shapes[5] as Shape, shapes[4] as Shape, { num: 314_573, den: QUANTUM }],
    [shapes[0] as Shape, shapes[3] as Shape, { num: QUANTUM, den: QUANTUM }],
  ];

  it.each(aliasPairs.map(([first, second, merged]) => [first.label, second.label, first, second, merged] as const))(
    'the alias C = min(C_t) over targets %s and %s equals floor(I0 / (1 + the merged sizing ratio))',
    async (_first, _second, first, second, merged) => {
      const arith = proofArith(z3.engine().api, 'B9-alias');
      const window = windowOf(arith);
      const firstCapacity = largestFitting(arith, window, 'C1', (point) => shapeAt(arith, first, point));
      const secondCapacity = largestFitting(arith, window, 'C2', (point) => shapeAt(arith, second, point));
      const alias = named(arith, 'C', arith.min(firstCapacity, secondCapacity));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, alias.eq(sizedCeiling(arith, window, merged)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  const withCapacity = (name: string) => {
    const arith = proofArith(z3.engine().api, name);
    const window = windowOf(arith);
    const under = arith.errorBound('under');
    const C = observedCapacity(arith, window, under);
    return { arith, window, under, C };
  };

  it(
    'B1 holds with C, the largest m with m + under_t(m) <= I0, as the ceiling',
    async () => {
      const { arith, window, under, C } = withCapacity('B9-B1');
      const marks = marksOf(arith, window, C, under, { capped: true });
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, b1Goal(arith, C, marks))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B2 (i) and (ii) hold with C as the ceiling',
    async () => {
      const fit = withCapacity('B9-B2-i');
      const fitMarks = marksOf(fit.arith, fit.window, fit.C, fit.under, { capped: true });
      const fitGoal = b2FitGoal(fit.arith, fit.window, fitMarks, fit.under);
      expect(await hypothesesSatisfiable(fit.arith)).toBe(true);
      expect(await prove(fit.arith, fitGoal)).toEqual({ status: 'proved' });
      const step = withCapacity('B9-B2-ii');
      const stepMarks = marksOf(step.arith, step.window, step.C, step.under, { capped: true });
      const stepGoal = b2StepGoal(step.arith, stepMarks);
      expect(await hypothesesSatisfiable(step.arith)).toBe(true);
      expect(await prove(step.arith, stepGoal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B4 holds with C as the ceiling',
    async () => {
      const { arith, window, under, C } = withCapacity('B9-B4');
      const marks = marksOf(arith, window, C, under, { capped: true });
      const goal = b4Goal(arith, window, C, marks, under);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B7 holds with C as the ceiling',
    async () => {
      const { arith, window, C } = withCapacity('B9-B7');
      const floor = toolFloorOf(arith, window, C);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, b7Goal(arith, floor))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B3 holds with C as the ceiling and freshUnder as the bound of the rebuilt input',
    async () => {
      const { arith, window, C } = withCapacity('B9-B3');
      const freshUnder = arith.errorBound('freshUnder');
      const maxInput = arith.int('maxInput');
      const total = arith.int('total');
      const region = arith.int('region');
      const item = arith.int('item');
      arith.given(maxInput.ge(0), maxInput.le(C), maxInput.add(freshUnder.at(maxInput)).le(window.I0));
      arith.given(total.ge(0), region.ge(0), region.le(total), item.ge(0), region.sub(item).ge(total.sub(maxInput)));
      const after = total.sub(region).add(item);
      freshUnder.monotone(after, maxInput);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, after.add(freshUnder.at(after)).le(window.I0))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
