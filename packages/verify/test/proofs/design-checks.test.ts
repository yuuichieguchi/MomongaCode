import { describe, expect, it } from 'vitest';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ErrorBound, ProofArith, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

type Ratio = { readonly num: number; readonly den: number };

const MAX_WINDOW = 2n ** 33n;
const QUANTUM = 2 ** 20;
const MIN_MARGIN = 32;
const MIN_OUTPUT_RESERVE = 256;
const MARGIN: Ratio = { num: 1, den: 50 };
const OUTPUT_RESERVE: Ratio = { num: 1, den: 4 };
const MAX_OUTPUT_WINDOW: Ratio = { num: 1, den: 2 };
const SUMMARY_ACCEPT: Ratio = { num: 13, den: 10 };
const SUMMARY_ITEM_OVERHEAD = 20;
const MIN_SUMMARY_TOKENS = 64;
const MAX_SUMMARY_TOKENS = 4096;

const ceilOf = (arith: ProofArith, ratio: Ratio, value: ProofInt): ProofInt =>
  arith.ceilDiv(value.mul(arith.ctx.Int.val(BigInt(ratio.num))), BigInt(ratio.den));
const floorOf = (arith: ProofArith, ratio: Ratio, value: ProofInt): ProofInt =>
  arith.floorDiv(value.mul(arith.ctx.Int.val(BigInt(ratio.num))), BigInt(ratio.den));

const named = (arith: ProofArith, name: string, value: ProofInt): ProofInt => {
  const variable = arith.int(name);
  arith.given(variable.eq(value));
  return variable;
};

const satisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

const windowOf = (arith: ProofArith) => {
  const { ctx } = arith;
  const W = arith.int('W');
  const maxOutput = arith.int('maxOutput');
  arith.given(W.ge(1), W.le(ctx.Int.val(MAX_WINDOW)), maxOutput.ge(1), maxOutput.le(ctx.Int.val(MAX_WINDOW)));
  const R = named(
    arith,
    'R',
    arith.min(arith.min(maxOutput, arith.max(ctx.Int.val(MIN_OUTPUT_RESERVE), ceilOf(arith, OUTPUT_RESERVE, W))), floorOf(arith, MAX_OUTPUT_WINDOW, W)),
  );
  const margin = named(arith, 'margin', arith.max(ceilOf(arith, MARGIN, W), ctx.Int.val(MIN_MARGIN)));
  const I0 = named(arith, 'I0', arith.max(ctx.Int.val(0), W.sub(R).sub(margin)));
  return { W, maxOutput, R, margin, I0 };
};

describe('design check 1: a configured tokenErrorRatio replacing the ratio of every own-counter reply, exact included', () => {
  const z3 = useZ3();

  const exactWithRatio = [1, 314_573, QUANTUM].map((num) => [num] as const);

  it.each(exactWithRatio)(
    'C_t with nothing reported equals floor(I0 / (1 + k/2^20)) for an exact target with configured ratio %i/2^20 and the exact minimum 0',
    async (num) => {
      const arith = proofArith(z3.engine().api, `check1-exact-${num}`);
      const { ctx } = arith;
      const window = windowOf(arith);
      const ratio = { num, den: QUANTUM };
      const zero = ctx.Int.val(0);
      const sigma = (point: ProofInt): ProofInt => ctx.If(point.eq(zero), zero, arith.max(zero, ceilOf(arith, ratio, point))) as ProofInt;
      const C = arith.int('C');
      const next = C.add(1);
      arith.given(C.ge(0), C.add(sigma(C)).le(window.I0), next.add(sigma(next)).gt(window.I0));
      expect(await satisfiable(arith)).toBe(true);
      const sized = arith.floorDiv(window.I0.mul(ctx.Int.val(BigInt(QUANTUM))), BigInt(QUANTUM + num));
      expect(await prove(arith, C.eq(sized))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'evidence: under today\'s rule (an exact reply stays exact) an exact target with configured ratio 314573/2^20 has C_t = I0, which differs from floor(I0 / (1 + sizingRatioFor))',
    async () => {
      const arith = proofArith(z3.engine().api, 'check1-exact-stays-exact');
      const { ctx } = arith;
      const window = windowOf(arith);
      const C = named(arith, 'C', window.I0);
      const sized = named(arith, 'sized', arith.floorDiv(window.I0.mul(ctx.Int.val(BigInt(QUANTUM))), BigInt(QUANTUM + 314_573)));
      expect(await satisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, C.eq(sized));
      expect(BigInt(model.C as string)).toBeGreaterThan(BigInt(model.sized as string));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

describe('design check 2: W - R >= marginFloor(W) over the schema domain contextWindow >= 1, maxOutputTokens >= 1', () => {
  const z3 = useZ3();

  it(
    'proves W - R >= marginFloor(W) for every W >= 63 and every maxOutputTokens >= 1',
    async () => {
      const arith = proofArith(z3.engine().api, 'check2-holds');
      const window = windowOf(arith);
      arith.given(window.W.ge(63));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, window.W.sub(window.R).ge(window.margin))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'proves that for W <= 62 it fails exactly when W - min(maxOutputTokens, floor(W/2)) < 32, where I0 = 0',
    async () => {
      const arith = proofArith(z3.engine().api, 'check2-range');
      const { ctx } = arith;
      const window = windowOf(arith);
      arith.given(window.W.le(62));
      const half = floorOf(arith, MAX_OUTPUT_WINDOW, window.W);
      const fails = window.W.sub(window.R).lt(window.margin);
      const predicted = window.W.sub(arith.min(window.maxOutput, half)).lt(ctx.Int.val(32));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(fails.eq(predicted), ctx.Implies(fails, window.I0.eq(0))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'evidence: refuted at W = 62 with maxOutputTokens = 62 (R = 31, margin 32) and holds at W = 63',
    async () => {
      const arith = proofArith(z3.engine().api, 'check2-evidence');
      const window = windowOf(arith);
      arith.given(window.W.eq(62), window.maxOutput.eq(62));
      const model = await expectRefuted(arith, window.W.sub(window.R).ge(window.margin));
      expect(model.R).toBe('31');
      expect(model.margin).toBe('32');
      expect(model.I0).toBe('0');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

const shapeOf = (arith: ProofArith, name: string): ErrorBound => {
  const sigma = arith.errorBound(name);
  arith.given(sigma.at(arith.ctx.Int.val(0)).eq(0));
  return sigma;
};

describe('design check 3: the split and the fresh count of one input can differ', () => {
  const z3 = useZ3();

  const meterModel = (arith: ProofArith) => {
    const { ctx } = arith;
    const window = windowOf(arith);
    arith.given(window.W.sub(window.R).ge(window.margin));
    const sigma = shapeOf(arith, 'sigma');
    const excess = arith.errorBound('E');
    const reportedA = arith.int('reportedA');
    const restA = arith.int('restA');
    const restB = arith.int('restB');
    const cFresh = arith.int('cFresh');
    const server = arith.int('server');
    arith.given(reportedA.ge(0), restA.ge(0), restB.ge(0), cFresh.ge(0), server.ge(0));
    const K = named(arith, 'K', reportedA.sub(restA));
    arith.given(K.ge(0));
    const cSplit = named(arith, 'cSplit', K.add(restB));
    const u = restA.add(restB);
    const sA = arith.int('sA');
    const sB = arith.int('sB');
    const lowA = arith.int('lowA');
    const highB = arith.int('highB');
    const highA = arith.int('highA');
    const lowB = arith.int('lowB');
    arith.given(sA.ge(0), sB.ge(0), lowA.ge(0), highB.ge(0), highA.ge(0), lowB.ge(0));
    const eA = sA.sub(restA);
    const eB = sB.sub(restB);
    arith.given(
      eA.ge(sigma.at(restA).neg().sub(lowA)),
      eB.le(sigma.at(restB).add(highB)),
      lowA.add(highB).le(window.margin.add(excess.at(u))),
      eA.le(sigma.at(restA).add(highA)),
      eB.ge(sigma.at(restB).neg().sub(lowB)),
      highA.add(lowB).le(window.margin),
      server.eq(reportedA.sub(sA).add(sB)),
    );
    const highFresh = arith.int('highFresh');
    const lowFresh = arith.int('lowFresh');
    arith.given(highFresh.ge(0), lowFresh.ge(0), highFresh.le(window.margin.add(excess.at(cFresh))), lowFresh.le(window.margin));
    arith.given(server.sub(cFresh).le(sigma.at(cFresh).add(highFresh)), server.sub(cFresh).ge(sigma.at(cFresh).neg().sub(lowFresh)));
    const zero = ctx.Int.val(0);
    const newPart = (m: ProofInt): ProofInt => arith.max(zero, m.sub(K));
    const splitUnder = (m: ProofInt): ProofInt => sigma.at(restA).add(sigma.at(newPart(m))).add(excess.at(restA.add(newPart(m))));
    const freshUnder = (m: ProofInt): ProofInt => sigma.at(m).add(excess.at(m));
    return { window, sigma, excess, restA, restB, K, cSplit, cFresh, server, u, splitUnder, freshUnder };
  };

  it.each(['split', 'fresh'] as const)(
    'evidence: a fit test m + min(splitUnder(m), freshUnder(m)) <= I0 at m = the %s count admits a server count above W - R',
    async (which) => {
      const arith = proofArith(z3.engine().api, `check3-min-${which}`);
      const model = meterModel(arith);
      const m = which === 'split' ? model.cSplit : model.cFresh;
      const under = arith.min(model.splitUnder(m), model.freshUnder(m));
      arith.given(m.add(under).le(model.window.I0));
      model.sigma.monotone(model.cSplit, model.cFresh);
      model.excess.monotone(model.cSplit, model.cFresh);
      expect(await satisfiable(arith)).toBe(true);
      const found = await expectRefuted(arith, model.server.le(model.window.W.sub(model.window.R)));
      expect(found.cSplit).not.toBe(found.cFresh);    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'one decomposition per build (split iff equal roots and K >= rest(a, j), else fresh): B8 (i) and (ii) hold with that decomposition alone',
    async () => {
      const arith = proofArith(z3.engine().api, 'check3-one-decomposition');
      const { ctx } = arith;
      const model = meterModel(arith);
      const equalRoots = ctx.Bool.const('equalRoots');
      const useSplit = ctx.And(equalRoots, model.K.ge(model.restA));
      const c = ctx.If(useSplit, model.cSplit, model.cFresh) as ProofInt;
      const sigmaTerms = ctx.If(useSplit, model.sigma.at(model.restA).add(model.sigma.at(model.restB)), model.sigma.at(model.cFresh)) as ProofInt;
      const under = ctx.If(useSplit, sigmaTerms.add(model.excess.at(model.u)), sigmaTerms.add(model.excess.at(model.cFresh))) as ProofInt;
      const fitSound = ctx.Implies(c.add(under).le(model.window.I0), model.server.le(model.window.W.sub(model.window.R)));
      const notFlagged = model.server.ge(c.sub(model.window.margin.add(sigmaTerms)));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(fitSound, notFlagged))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'one decomposition per build: its under(m) is non-decreasing in m',
    async () => {
      const arith = proofArith(z3.engine().api, 'check3-one-decomposition-monotone');
      const { ctx } = arith;
      const sigma = shapeOf(arith, 'sigma');
      const excess = arith.errorBound('E');
      const K = arith.int('K');
      const restA = arith.int('restA');
      const first = arith.int('m1');
      const second = arith.int('m2');
      const useSplit = ctx.Bool.const('useSplit');
      arith.given(K.ge(0), restA.ge(0), first.ge(0), first.le(second));
      const zero = ctx.Int.val(0);
      const newPart = (m: ProofInt): ProofInt => arith.max(zero, m.sub(K));
      const under = (m: ProofInt): ProofInt =>
        ctx.If(useSplit, sigma.at(restA).add(sigma.at(newPart(m))).add(excess.at(restA.add(newPart(m)))), sigma.at(m).add(excess.at(m))) as ProofInt;
      sigma.monotone(newPart(first), newPart(second));
      excess.monotone(restA.add(newPart(first)), restA.add(newPart(second)));
      sigma.monotone(first, second);
      excess.monotone(first, second);
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, under(first).le(under(second)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

describe('design check 4: B5 when the summary cap differs between the two proactive compactions', () => {
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
    arith.given(growth.ge(0), fresh.ge(0));
    const first = named(arith, 'item1Tokens', summaryItemTokens(arith, cap1));
    const second = named(arith, 'item2Tokens', summaryItemTokens(arith, cap2));
    arith.given(previousSummary.ge(0), previousSummary.le(first));
    const item = named(arith, 'item2', second.add(growth));
    const region = named(arith, 'region', previousSummary.add(fresh));
    return { cap1, cap2, previousSummary, fresh, item, region, first, second };
  };

  it(
    'evidence: with today\'s acceptance region >= 2 item2, fresh >= summaryItemTokensFor(cap2) is refuted; smallest case cap1 = 65, cap2 = 64, fresh = 103',
    async () => {
      const arith = proofArith(z3.engine().api, 'check4-refuted');
      const model = twoCompactions(arith);
      arith.given(model.region.ge(model.item.mul(2)), model.cap1.eq(65), model.cap2.eq(64), model.fresh.eq(103), model.previousSummary.eq(model.first));
      arith.given(model.item.eq(model.second));
      const found = await expectRefuted(arith, model.fresh.ge(model.second));
      expect(found.item1Tokens).toBe('105');
      expect(found.item2Tokens).toBe('104');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'proves that today\'s rule gives fresh >= summaryItemTokensFor(cap2) whenever cap1 <= cap2, and that a refutation needs cap1 > cap2',
    async () => {
      const arith = proofArith(z3.engine().api, 'check4-cap-order');
      const { ctx } = arith;
      const model = twoCompactions(arith);
      arith.given(model.region.ge(model.item.mul(2)));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.Implies(model.cap1.le(model.cap2), model.fresh.ge(model.second)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'proves fresh >= item2 >= summaryItemTokensFor(cap2) for every pair of caps when acceptance compares region >= item2 + max(item2, previousSummary)',
    async () => {
      const arith = proofArith(z3.engine().api, 'check4-repaired');
      const { ctx } = arith;
      const model = twoCompactions(arith);
      arith.given(model.region.ge(model.item.add(arith.max(model.item, model.previousSummary))));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(model.fresh.ge(model.item), model.fresh.ge(model.second)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
