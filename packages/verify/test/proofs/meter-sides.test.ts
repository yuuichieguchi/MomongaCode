import { describe, expect, it } from 'vitest';
import { ESTIMATED_ERROR } from '@momonga/protocol';
import { proofArith } from '../../src/proofs/arith.ts';
import type { ErrorBound, ProofArith, ProofBool, ProofInt } from '../../src/proofs/arith.ts';
import { expectRefuted, prove } from '../../src/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { ceilOf, hypothesesSatisfiable, named, windowOf } from './budget-model.ts';
import type { Window } from './budget-model.ts';

type KeptRule = 'reported' | 'conservative' | 'fresh';

const KEPT_RULES: readonly KeptRule[] = ['reported', 'conservative', 'fresh'];

const shapeOf = (arith: ProofArith, name: string): ErrorBound => {
  const sigma = arith.errorBound(name);
  arith.given(sigma.at(arith.ctx.Int.val(0)).eq(0));
  return sigma;
};

type Decomposition = {
  readonly c: ProofInt;
  readonly O: ProofInt;
  readonly sigmaA: ProofInt;
  readonly sigmaB: ProofInt;
  readonly excess: ProofInt;
  readonly under: ProofInt;
};

const workingWindow = (arith: ProofArith): Window => {
  const window = windowOf(arith);
  arith.given(window.W.sub(window.R).ge(window.margin));
  return window;
};

type Split = Decomposition & { readonly reportedA: ProofInt; readonly restA: ProofInt; readonly restB: ProofInt };

const splitOf = (arith: ProofArith, sigma: ErrorBound, rule: KeptRule, prefix = ''): Split => {
  const reportedA = arith.int(`${prefix}reportedA`);
  const O = arith.int(`${prefix}O`);
  const restA = arith.int(`${prefix}restA`);
  const restB = arith.int(`${prefix}restB`);
  const excess = arith.int(`${prefix}E`);
  arith.given(reportedA.ge(0), O.ge(0), restA.ge(0), restB.ge(0), excess.ge(0));
  if (rule === 'reported') arith.given(O.eq(0));
  if (rule === 'fresh') arith.given(O.eq(0), reportedA.eq(0), restA.eq(0));
  const K = named(arith, `${prefix}K`, reportedA.add(O).sub(restA));
  arith.given(K.ge(0));
  const c = named(arith, `${prefix}c`, K.add(restB));
  const sigmaA = sigma.at(restA);
  const sigmaB = sigma.at(restB);
  const under = sigmaA.add(sigmaB).add(excess);
  return { reportedA, restA, restB, c, O, sigmaA, sigmaB, excess, under };
};

const serverOf = (
  arith: ProofArith,
  window: Window,
  split: Split,
  prefix = '',
): { readonly server: ProofInt; readonly eA: ProofInt; readonly eB: ProofInt } => {
  const sA = arith.int(`${prefix}sA`);
  const sB = arith.int(`${prefix}sB`);
  const overA = arith.int(`${prefix}missLowA`);
  const overB = arith.int(`${prefix}missHighB`);
  const underA = arith.int(`${prefix}missHighA`);
  const underB = arith.int(`${prefix}missLowB`);
  arith.given(sA.ge(0), sB.ge(0), overA.ge(0), overB.ge(0), underA.ge(0), underB.ge(0));
  const eA = sA.sub(split.restA);
  const eB = sB.sub(split.restB);
  arith.given(
    eA.ge(split.sigmaA.neg().sub(overA)),
    eB.le(split.sigmaB.add(overB)),
    overA.add(overB).le(window.margin.add(split.excess)),
    eA.le(split.sigmaA.add(underA)),
    eB.ge(split.sigmaB.neg().sub(underB)),
    underA.add(underB).le(window.margin),
  );
  const server = named(arith, `${prefix}server`, split.reportedA.sub(sA).add(sB));
  return { server, eA, eB };
};

const flagged = (window: Window, split: Decomposition, report: ProofInt): ProofBool =>
  report.lt(split.c.sub(window.margin.add(split.O).add(split.sigmaA).add(split.sigmaB)));

describe('B8: the meter has two sides, each sound per part', () => {
  const z3 = useZ3();

  it.each(KEPT_RULES)(
    'B8 (i) with kept rule %s: -e_a + e_b - O <= sigma(rest a) + sigma(rest b) + E(u) + marginFloor, so a count passing the fit test is at most W - R on the server',
    async (rule) => {
      const arith = proofArith(z3.engine().api, `B8-i-${rule}`);
      const { ctx } = arith;
      const window = workingWindow(arith);
      const sigma = shapeOf(arith, 'sigma');
      const split = splitOf(arith, sigma, rule);
      const { server, eA, eB } = serverOf(arith, window, split);
      const goal = ctx.And(
        eA.neg().add(eB).sub(split.O).le(split.under.add(window.margin)),
        ctx.Implies(split.c.add(split.under).le(window.I0), server.le(window.W.sub(window.R))),
      );
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it.each(KEPT_RULES)(
    'B8 (ii) with kept rule %s: e_a - e_b <= sigma(rest a) + sigma(rest b) + marginFloor, so an untruncated report is never flagged',
    async (rule) => {
      const arith = proofArith(z3.engine().api, `B8-ii-${rule}`);
      const { ctx } = arith;
      const window = workingWindow(arith);
      const sigma = shapeOf(arith, 'sigma');
      const split = splitOf(arith, sigma, rule);
      const { server, eA, eB } = serverOf(arith, window, split);
      const goal = ctx.And(eA.sub(eB).le(split.sigmaA.add(split.sigmaB).add(window.margin)), ctx.Not(flagged(window, split, server)));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B8 (iii) c - O, the verdict and the measured miss are the same for kept = reported and kept = max(estimate, reported)',
    async () => {
      const arith = proofArith(z3.engine().api, 'B8-iii');
      const { ctx } = arith;
      const window = workingWindow(arith);
      const sigma = shapeOf(arith, 'sigma');
      const reported = splitOf(arith, sigma, 'reported', 'kr_');
      const conservative = splitOf(arith, sigma, 'conservative', 'km_');
      arith.given(
        reported.reportedA.eq(conservative.reportedA),
        reported.restA.eq(conservative.restA),
        reported.restB.eq(conservative.restB),
      );
      const report = arith.int('report');
      arith.given(report.ge(0));
      const missOf = (split: Decomposition): ProofInt =>
        arith.max(ctx.Int.val(0), report.sub(split.c.sub(split.O)).sub(split.sigmaA).sub(split.sigmaB));
      const goal = ctx.And(
        reported.c.sub(reported.O).eq(conservative.c.sub(conservative.O)),
        flagged(window, reported, report).eq(flagged(window, conservative, report)),
        missOf(reported).eq(missOf(conservative)),
      );
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B8 (iv) E(v) >= a + b v - marginFloor for every non-negative affine miss a + b u_i = miss_i consistent with a report, with scale_i(v) = max(1, v/u_i), or 1 when u_i = 0',
    async () => {
      const arith = proofArith(z3.engine().api, 'B8-iv');
      const { ctx } = arith;
      const window = workingWindow(arith);
      const miss = arith.int('miss');
      const u = arith.int('u');
      const v = arith.int('v');
      const scaledMiss = arith.int('scaledMiss');
      const otherReports = arith.int('otherReports');
      arith.given(miss.ge(0), u.ge(0), v.ge(0), otherReports.ge(0));
      arith.given(u.le(ctx.Int.val(2n ** 33n)), v.le(ctx.Int.val(2n ** 33n)));
      const scaled = ctx.And(u.ge(1), v.gt(u));
      arith.given(
        ctx.Implies(scaled, ctx.And(scaledMiss.mul(u).ge(miss.mul(v)), scaledMiss.sub(1).mul(u).lt(miss.mul(v)))),
        ctx.Implies(ctx.Not(scaled), scaledMiss.eq(miss)),
      );
      const fromThisReport = arith.max(ctx.Int.val(0), scaledMiss.sub(window.margin));
      const excess = named(arith, 'E', arith.max(fromThisReport, otherReports));
      const fixed = ctx.Real.const('a');
      const proportional = ctx.Real.const('b');
      arith.given(
        fixed.ge(0),
        proportional.ge(0),
        ctx.Implies(u.ge(1), fixed.add(proportional.mul(ctx.ToReal(u))).eq(ctx.ToReal(miss))),
        ctx.Implies(u.eq(0), ctx.And(fixed.eq(ctx.ToReal(miss)), proportional.eq(0))),
      );
      const goal = ctx.ToReal(excess).ge(fixed.add(proportional.mul(ctx.ToReal(v))).sub(ctx.ToReal(window.margin)));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal as ProofBool)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B8 (v) the split for any j under an equal root with K >= 0 and the fresh count are both sound, so whichever attains under_t passes (i) and (ii)',
    async () => {
      const arith = proofArith(z3.engine().api, 'B8-v');
      const { ctx } = arith;
      const window = workingWindow(arith);
      const sigma = shapeOf(arith, 'sigma');
      const split = splitOf(arith, sigma, 'conservative', 'split_');
      const fresh = splitOf(arith, sigma, 'fresh', 'fresh_');
      const splitServer = serverOf(arith, window, split, 'split_');
      const freshServer = serverOf(arith, window, fresh, 'fresh_');
      arith.given(splitServer.server.eq(freshServer.server));
      const useSplit = ctx.Bool.const('useSplit');
      const pick = (first: ProofInt, second: ProofInt): ProofInt => ctx.If(useSplit, first, second) as ProofInt;
      const chosen: Decomposition = {
        c: pick(split.c, fresh.c),
        O: pick(split.O, fresh.O),
        sigmaA: pick(split.sigmaA, fresh.sigmaA),
        sigmaB: pick(split.sigmaB, fresh.sigmaB),
        excess: pick(split.excess, fresh.excess),
        under: pick(split.under, fresh.under),
      };
      const server = splitServer.server;
      const goal = ctx.And(
        ctx.Implies(chosen.c.add(chosen.under).le(window.I0), server.le(window.W.sub(window.R))),
        ctx.Not(flagged(window, chosen, server)),
      );
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'B8 (v) under_t(m) = min(splitUnder(m), freshUnder(m)) is non-decreasing in m for non-decreasing sigma and E with sigma(0) = 0',
    async () => {
      const arith = proofArith(z3.engine().api, 'B8-v-monotone');
      const { ctx } = arith;
      const sigma = shapeOf(arith, 'sigma');
      const excess = arith.errorBound('E');
      const K = arith.int('K');
      const restA = arith.int('restA');
      const first = arith.int('m1');
      const second = arith.int('m2');
      arith.given(K.ge(0), restA.ge(0), first.ge(0), first.le(second));
      const zero = ctx.Int.val(0);
      const newPart = (m: ProofInt): ProofInt => arith.max(zero, m.sub(K));
      const splitUnder = (m: ProofInt): ProofInt => sigma.at(restA).add(sigma.at(newPart(m))).add(excess.at(restA.add(newPart(m))));
      const freshUnder = (m: ProofInt): ProofInt => sigma.at(m).add(excess.at(m));
      const underT = (m: ProofInt): ProofInt => arith.min(splitUnder(m), freshUnder(m));
      sigma.monotone(newPart(first), newPart(second));
      excess.monotone(restA.add(newPart(first)), restA.add(newPart(second)));
      sigma.monotone(first, second);
      excess.monotone(first, second);
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, underT(first).le(underT(second)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

describe('B8w: the whole-count relative rule is unsound when the estimated share changes (evidence)', () => {
  const z3 = useZ3();

  it(
    'refutes server <= c + max(ceil(rel c), ceil(3/10 new)) with 10,000 counted, 1,000 new tokens 50% low, then 5,000 new tokens 2,500 low',
    async () => {
      const arith = proofArith(z3.engine().api, 'B8w');
      const { ctx } = arith;
      const firstCount = named(arith, 'firstCount', ctx.Int.val(10_000));
      const firstReport = named(arith, 'firstReport', ctx.Int.val(10_500));
      const kept = named(arith, 'kept', arith.max(firstCount, firstReport));
      const newTokens = named(arith, 'newTokens', ctx.Int.val(5_000));
      const c = named(arith, 'c', kept.add(newTokens));
      const missOnNew = arith.int('missOnNew');
      arith.given(missOnNew.ge(0), missOnNew.le(ctx.Int.val(2_500)));
      const relativeBound = arith.ceilDiv(firstReport.sub(firstCount).mul(c), 10_000n);
      const bound = named(arith, 'bound', arith.max(relativeBound, ceilOf(arith, ESTIMATED_ERROR, newTokens)));
      const server = named(arith, 'server', c.add(missOnNew));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      const model = await expectRefuted(arith, server.le(c.add(bound)));
      expect(model.c).toBe('15500');
      expect(model.bound).toBe('1500');
      expect(BigInt(model.missOnNew as string)).toBeGreaterThan(1500n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
