import { describe, expect, it } from 'vitest';
import { MIN_ITEM_CAP, inputCeilingFor, itemCapFor, workingStateCapFor } from '@momonga/context';
import {
  COMPACTION_MIN_GAIN,
  COMPACT_AT,
  ESTIMATED_ERROR,
  ITEM_CAP,
  ITEM_ROOM,
  MAX_SUMMARY_TOKENS,
  MIN_SUMMARY_TOKENS,
  SUMMARY_ACCEPT,
  SUMMARY_ITEM_OVERHEAD,
  applyCapabilityOverride,
} from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { anyCeiling, b2FitGoal, b2StepGoal, ceilOf, floorOf, hypothesesSatisfiable, marksOf, named, windowOf } from './budget-model.ts';

const smallWindowCapabilities = (): Capabilities =>
  applyCapabilityOverride(
    {
      contextWindow: 8192,
      maxOutputTokens: 1024,
      toolCalling: 'native',
      structuredOutput: 'none',
      streaming: true,
      stopSequences: false,
      imageInput: false,
      parallelToolCalls: false,
      schemaDialect: 'json-schema-2020-12',
      tokenCounting: 'estimated',
      usageReported: true,
      maxConcurrency: 1,
      source: 'declared',
    },
    {},
  );

describe('B2: an input at or below H fits with its bound, and K(g) steps of growth g >= 1 stay at or below H', () => {
  const z3 = useZ3();

  const marksFor = (name: string) => {
    const arith = proofArith(z3.engine().api, name);
    const window = windowOf(arith);
    const ceiling = anyCeiling(arith, window);
    const b = arith.errorBound('b');
    const marks = marksOf(arith, window, ceiling, b, { capped: true });
    return { arith, window, b, marks };
  };

  it(
    'B2 (i) proves total <= H implies total + b(total) <= I0 for every non-decreasing b',
    async () => {
      const { arith, window, b, marks } = marksFor('B2-i');
      const goal = b2FitGoal(arith, window, marks, b);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B2 (ii) proves the step lemma total_s <= H - g and total_s+1 <= total_s + g imply total_s+1 <= H for g >= 1',
    async () => {
      const { arith, marks } = marksFor('B2-ii');
      const goal = b2StepGoal(arith, marks);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B2 proves that after total0, step k <= K(g) = floor((H - total0)/g) of growth g >= 1 stays at or below H',
    async () => {
      const arith = proofArith(z3.engine().api, 'B2-K');
      const H = arith.int('H');
      const total0 = arith.int('total0');
      const g = arith.int('g');
      const k = arith.int('k');
      const totalK = arith.int('totalK');
      arith.given(total0.ge(0), total0.le(H), g.ge(1), k.ge(0));
      const spacing = arith.int('spacing');
      arith.given(spacing.mul(g).le(H.sub(total0)), spacing.add(1).mul(g).gt(H.sub(total0)));
      arith.given(k.le(spacing), totalK.le(total0.add(k.mul(g))));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, totalK.le(H))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

describe('B2w: no low mark guarantees one admissible step without eviction (evidence)', () => {
  const z3 = useZ3();

  it('reproduces the 4.4 numbers at W 8192 from the production budget functions', () => {
    const capabilities = smallWindowCapabilities();
    expect(inputCeilingFor(capabilities)).toBe(5387);
    expect(itemCapFor(capabilities, 5387 - 2900)).toBe(1243);
    expect(workingStateCapFor(capabilities)).toBe(246);
  });

  it(
    'refutes "one step after evicting every unprotected output keeps total <= H" at W 8192, maxOutputTokens 1024, estimated counting, F 2900',
    async () => {
      const capabilities = smallWindowCapabilities();
      const arith = proofArith(z3.engine().api, 'B2w');
      const { ctx } = arith;
      const window = windowOf(arith);
      arith.given(window.W.eq(8192), window.maxOutput.eq(1024));
      const sizedCeiling = arith.floorDiv(window.I0.mul(ctx.Int.val(BigInt(ESTIMATED_ERROR.den))), BigInt(ESTIMATED_ERROR.den + ESTIMATED_ERROR.num));
      const ceiling = named(arith, 'ceiling', sizedCeiling);
      const estimatedBound = (point: ProofInt): ProofInt => arith.max(ctx.Int.val(1), ceilOf(arith, ESTIMATED_ERROR, point));
      const F = named(arith, 'F', ctx.Int.val(2900));
      const room = named(arith, 'room', ceiling.sub(F));
      const maxInputB = arith.int('maxInputB');
      const next = maxInputB.add(1);
      arith.given(
        maxInputB.ge(0),
        maxInputB.le(ceiling),
        maxInputB.add(estimatedBound(maxInputB)).le(window.I0),
        ctx.Or(next.gt(ceiling), next.add(estimatedBound(next)).gt(window.I0)),
      );
      const H = named(arith, 'H', arith.min(F.add(floorOf(arith, COMPACT_AT, room)), maxInputB));
      const minItemCap = ctx.Int.val(MIN_ITEM_CAP);
      const base = arith.max(minItemCap, floorOf(arith, ITEM_CAP, window.I0));
      const itemCap = named(arith, 'itemCap', arith.max(minItemCap, arith.min(base, floorOf(arith, ITEM_ROOM, room))));
      const A = arith.int('A');
      const output = arith.int('output');
      const workingState = arith.int('workingState');
      const delta = arith.int('delta');
      const total0 = named(arith, 'total0', F);
      arith.given(
        A.ge(0),
        A.le(window.R),
        output.ge(0),
        output.le(itemCap),
        workingState.ge(0),
        workingState.le(ctx.Int.val(workingStateCapFor(capabilities))),
        delta.ge(0),
        delta.le(estimatedBound(total0)),
      );
      const total1 = named(arith, 'total1', total0.add(A).add(output).add(workingState).add(delta));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, total1.le(H));
      expect(model.ceiling).toBe('5387');
      expect(model.room).toBe('2487');
      expect(model.H).toBe('4640');
      expect(model.itemCap).toBe('1243');
      expect(BigInt(model.total1 as string)).toBeGreaterThan(4640n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

describe('B5: two proactive compactions are separated by at least summaryItemTokensFor(cap2) new tokens, for every pair of caps', () => {
  const z3 = useZ3();

  const summaryItemTokens = (arith: ProofArith, cap: ProofInt): ProofInt =>
    ceilOf(arith, SUMMARY_ACCEPT, cap).add(arith.ctx.Int.val(SUMMARY_ITEM_OVERHEAD));

  const twoCompactions = (arith: ProofArith) => {
    const cap1 = arith.int('cap1');
    const cap2 = arith.int('cap2');
    const previousSummary = arith.int('previousSummary');
    const fresh = arith.int('fresh');
    const growth = arith.int('workingStateGrowth');
    for (const cap of [cap1, cap2]) arith.given(cap.ge(MIN_SUMMARY_TOKENS), cap.le(MAX_SUMMARY_TOKENS));
    arith.given(growth.ge(0), fresh.ge(0), previousSummary.ge(0));
    const firstItem = named(arith, 'item1Tokens', summaryItemTokens(arith, cap1));
    const secondItem = named(arith, 'item2Tokens', summaryItemTokens(arith, cap2));
    const item = named(arith, 'item', secondItem.add(growth));
    const region = named(arith, 'region', previousSummary.add(fresh));
    const gained = ceilOf(arith, COMPACTION_MIN_GAIN, item);
    return { cap1, cap2, previousSummary, fresh, growth, firstItem, secondItem, item, region, gained };
  };

  it(
    'B5 proves at least item >= summaryItemTokensFor(cap2) new tokens under region >= max(COMPACTION_MIN_GAIN x item, item + previousSummary)',
    async () => {
      const arith = proofArith(z3.engine().api, 'B5');
      const { ctx } = arith;
      const model = twoCompactions(arith);
      arith.given(model.region.ge(arith.max(model.gained, model.item.add(model.previousSummary))));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(model.fresh.ge(model.item), model.item.ge(model.secondItem)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B5 proves the rule equals today\'s region >= COMPACTION_MIN_GAIN x item whenever previousSummary <= (COMPACTION_MIN_GAIN - 1) x item',
    async () => {
      const arith = proofArith(z3.engine().api, 'B5-reduces');
      const model = twoCompactions(arith);
      arith.given(model.previousSummary.le(model.gained.sub(model.item)));
      const revised = model.region.ge(arith.max(model.gained, model.item.add(model.previousSummary)));
      const today = model.region.ge(model.gained);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, revised.eq(today))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B5w (evidence) refutes today\'s region >= COMPACTION_MIN_GAIN x item for a falling cap: caps 65 then 64 accept 103 new tokens, below 104',
    async () => {
      const arith = proofArith(z3.engine().api, 'B5w');
      const model = twoCompactions(arith);
      arith.given(model.previousSummary.le(model.firstItem), model.region.ge(model.gained));
      arith.given(model.cap1.eq(65), model.cap2.eq(64), model.growth.eq(0), model.previousSummary.eq(model.firstItem), model.fresh.eq(103));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const found = await expectRefuted(arith, model.fresh.ge(model.secondItem));
      expect(found.item1Tokens).toBe('105');
      expect(found.item2Tokens).toBe('104');
      expect(found.fresh).toBe('103');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
