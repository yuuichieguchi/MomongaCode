import { describe, expect, it } from 'vitest';
import { PRICE_UNITS_PER_NANO, admitRequest, composeBudget, nanoOfCost, nanoOfUnits, worstCaseUnits } from '@momonga/protocol';
import type { AdmissionAsk, ComposedBudget, TreeSpend } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofBool, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { hypothesesSatisfiable } from './budget-model.ts';
import { PRESENCES, admissionOf, askOf, counted, nanoOfUnitsOf, spendOf, valuesAt, worstUnitsOf } from './money-model.ts';
import type { AdmissionTerms, AskTerms, Presence, SpendTerms } from './money-model.ts';
import { enqueue, harness, mustClaim, mustRun, newSession } from '../../../store/test/helpers.ts';

const NOT_PROVED =
  'what these proofs do not prove: that the price table equals the provider bill, that the estimate bounds the real input, that the upstream honours max_output_tokens, and any amount past Number.MAX_SAFE_INTEGER, where admitRequest clamps';

const PRICE = { inUnits: 3_000_000n, outUnits: 15_000_000n };

const NO_SPEND: TreeSpend = { totalTokens: 0, costNano: 0, unpricedCalls: 0, reservedTokens: 0, reservedNano: 0 };

type Sample = { readonly ask: AdmissionAsk; readonly spend: TreeSpend };

const sample = (ask: Partial<AdmissionAsk>, spend: Partial<TreeSpend> = {}): Sample => ({
  ask: { inputUpper: 1000, outputWanted: 4000, outputFloor: 256, price: PRICE, limits: {}, ...ask },
  spend: { ...NO_SPEND, ...spend },
});

const SAMPLES: readonly Sample[] = [
  sample({ limits: { costNano: 100_000 } }),
  sample({ limits: { costNano: 66_000 } }, { costNano: 30_000, reservedNano: 33_000 }),
  sample({ limits: { costNano: 63_000 } }),
  sample({ limits: { costNano: 6_840 } }),
  sample({ limits: { costNano: 6_839 } }),
  sample({ limits: { costNano: 3_000 } }),
  sample({ limits: { costNano: 2_999 } }),
  sample({ limits: { costNano: 50_000 } }, { costNano: 50_000 }),
  sample({ limits: { costNano: 1 }, inputUpper: 0, price: { inUnits: 1n, outUnits: 7n } }),
  sample({ limits: { costNano: 10 }, price: { inUnits: 1n, outUnits: 0n } }),
  sample({ limits: { costNano: 1_000 }, inputUpper: 7, outputWanted: 0, outputFloor: 256, price: { inUnits: 333_333n, outUnits: 999_999n } }),
  sample({ limits: { tokens: 100_000 } }),
  sample({ limits: { tokens: 5_000 } }, { totalTokens: 100, reservedTokens: 200 }),
  sample({ limits: { tokens: 1_256 } }),
  sample({ limits: { tokens: 1_255 } }),
  sample({ limits: { tokens: 1_000 } }),
  sample({ limits: { tokens: 10_000, costNano: 40_000 } }, { totalTokens: 3_000, costNano: 1_234, reservedNano: 77 }),
  sample({ limits: { tokens: 2_000, costNano: 1_000_000 } }),
  sample({ limits: { tokens: 1_000_000, costNano: 20_001 }, price: { inUnits: 1_234_567n, outUnits: 7_654_321n } }),
  sample({ limits: { tokens: 1_500, costNano: 10_000 }, outputFloor: 100 }, { totalTokens: 100, reservedNano: 100 }),
];

const presenceOf = (ask: AdmissionAsk): Presence => ({ tokens: ask.limits.tokens !== undefined, cost: ask.limits.costNano !== undefined });

const fixedOf = ({ ask, spend }: Sample): Record<string, bigint> => ({
  inputUpper: BigInt(ask.inputUpper),
  outputWanted: BigInt(ask.outputWanted),
  outputFloor: BigInt(ask.outputFloor),
  inUnits: ask.price?.inUnits ?? 0n,
  outUnits: ask.price?.outUnits ?? 0n,
  tokenLimit: BigInt(ask.limits.tokens ?? 0),
  costLimit: BigInt(ask.limits.costNano ?? 0),
  totalTokens: BigInt(spend.totalTokens),
  spendReservedTokens: BigInt(spend.reservedTokens),
  costNano: BigInt(spend.costNano),
  spendReservedNano: BigInt(spend.reservedNano),
});

const modelled = (arith: ProofArith, presence: Presence): { ask: AskTerms; spend: SpendTerms; admission: AdmissionTerms } => {
  const ask = askOf(arith);
  const spend = spendOf(arith);
  return { ask, spend, admission: admissionOf(arith, ask, spend, presence) };
};

const nameOf = (presence: Presence): string => [presence.tokens ? 'tokens' : '', presence.cost ? 'cost' : ''].filter((part) => part !== '').join('+');

const sum = (terms: readonly ProofInt[]): ProofInt => terms.slice(1).reduce((total, term) => total.add(term), terms[0] as ProofInt);

describe(`money ceiling proofs (design/tools.md section 3.6: ceiling induction, rounding, cap fit, composition, tree conservation); ${NOT_PROVED}`, () => {
  const z3 = useZ3();

  it(
    'reads admitRequest of the product at sampled asks and spends, so the encoding below is the code and not itself',
    async () => {
      for (const entry of SAMPLES) {
        const presence = presenceOf(entry.ask);
        const arith = proofArith(z3.engine().api, 'admission-sample');
        const { admission } = modelled(arith, presence);
        const values = await valuesAt(arith, fixedOf(entry), { cap: admission.cap, reservedTokens: admission.reservedTokens, reservedNano: admission.reservedNano, admitted: admission.admitted });
        const verdict = admitRequest(entry.ask, entry.spend);
        expect(values['admitted'], JSON.stringify(entry, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value))).toBe(String(verdict.kind === 'admitted'));
        if (verdict.kind !== 'admitted') continue;
        expect([values['cap'], values['reservedTokens'], values['reservedNano']]).toEqual([String(verdict.maxOutputTokens), String(verdict.reservedTokens), String(verdict.reservedNano)]);
      }
      const { price: _price, ...unpriced } = sample({ limits: { costNano: 1_000 } }).ask;
      expect(admitRequest(unpriced, NO_SPEND)).toMatchObject({ kind: 'refused', dimension: 'cost', cause: 'unpriced' });
    },
    SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS,
  );

  it.each(PRESENCES)(
    'B2 ceiling ($tokens tokens, $cost cost): an admitted request keeps the held spend plus its reservation within every limit it is admitted under',
    async (presence) => {
      const arith = proofArith(z3.engine().api, `B2-ceiling-${nameOf(presence)}`);
      const { ask, admission } = modelled(arith, presence);
      const { ctx } = arith;
      const goal = ctx.Implies(
        admission.admitted,
        ctx.And(
          presence.cost ? admission.heldNano.add(admission.reservedNano).le(ask.costLimit) : ctx.Bool.val(true),
          presence.tokens ? admission.heldTokens.add(admission.reservedTokens).le(ask.tokenLimit) : ctx.Bool.val(true),
          admission.cap.ge(admission.floor),
          admission.cap.le(ask.outputWanted),
        ),
      );
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it.each(PRESENCES)(
    'B5 cap fit ($tokens tokens, $cost cost): the cap is the largest that fits, one more output token would pass the limit that bound it, and a refusal means the floor itself does not fit',
    async (presence) => {
      const arith = proofArith(z3.engine().api, `B5-cap-${nameOf(presence)}`);
      const { ask, admission } = modelled(arith, presence);
      const { ctx } = arith;
      const tokensBind = presence.tokens ? ask.inputUpper.add(admission.cap).add(1).gt(ask.tokenLimit.sub(admission.heldTokens)) : ctx.Bool.val(false);
      const costBinds = presence.cost ? ctx.And(ask.outUnits.gt(0), worstUnitsOf(ask.inputUpper, admission.cap.add(1), ask).gt(admission.availableUnits)) : ctx.Bool.val(false);
      const tokensFloorFails = presence.tokens ? admission.tokenRoom.lt(admission.floor) : ctx.Bool.val(false);
      const costFloorFails = presence.cost ? worstUnitsOf(ask.inputUpper, admission.floor, ask).gt(admission.availableUnits) : ctx.Bool.val(false);
      const goal = ctx.And(
        ctx.Implies(ctx.And(admission.admitted, admission.cap.lt(ask.outputWanted)), ctx.Or(tokensBind, costBinds)),
        ctx.Implies(admission.admitted, ctx.Not(ctx.Or(tokensFloorFails, costFloorFails))),
        ctx.Implies(ctx.Not(admission.admitted), ctx.Or(tokensFloorFails, costFloorFails)),
      );
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it('B3 rounding reads nanoOfUnits and nanoOfCost of the product at sampled amounts', () => {
    const units = [0n, 1n, 999_999n, 1_000_000n, 1_000_001n, 1_500_400_000n, 123_456_789_012n, 63_000_000_000n];
    for (const amount of units) {
      const expected = (amount + PRICE_UNITS_PER_NANO - 1n) / PRICE_UNITS_PER_NANO;
      expect(BigInt(nanoOfUnits(amount.toString()))).toBe(expected);
      expect(BigInt(nanoOfCost({ amount: 0, units: amount.toString() }))).toBe(expected);
    }
    expect(nanoOfCost({ amount: 1e-12, units: null })).toBe(1);
    expect(nanoOfCost({ amount: 0.0000015004, units: null })).toBe(1501);
    expect(admitRequest(sample({ limits: { costNano: 100_000 } }).ask, NO_SPEND)).toMatchObject({ reservedNano: Number((worstCaseUnits(1000, 4000, PRICE) + PRICE_UNITS_PER_NANO - 1n) / PRICE_UNITS_PER_NANO) });
  });

  it(
    'B3 rounding: the recorded charge is at least the exact charge and less than one nano-USD above it, and the charge of a response within its admission never passes the reservation',
    async () => {
      const arith = proofArith(z3.engine().api, 'B3-rounding');
      const { ctx } = arith;
      const units = counted(arith, 'units');
      const nano = nanoOfUnitsOf(arith, units);
      const scale = ctx.Int.val(PRICE_UNITS_PER_NANO);
      const exact = ctx.And(nano.mul(scale).ge(units), nano.mul(scale).lt(units.add(scale)));
      const { ask, admission } = modelled(arith, { tokens: false, cost: true });
      const inputTokens = counted(arith, 'inputTokens');
      const outputTokens = counted(arith, 'outputTokens');
      arith.given(inputTokens.le(ask.inputUpper), outputTokens.le(admission.cap));
      const charge = nanoOfUnitsOf(arith, worstUnitsOf(inputTokens, outputTokens, ask));
      const withinReservation = ctx.Implies(admission.admitted, charge.le(admission.reservedNano));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(exact, withinReservation))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  type Dimension = 'tokens' | 'costUsd' | 'timeMs';
  const CEILED: readonly Dimension[] = ['tokens', 'costUsd', 'timeMs'];

  it('B8 composition reads composeBudget of the product at sampled budgets', () => {
    const values = [undefined, 0, 1, 5, 1_000] as const;
    for (const declared of values) {
      for (const ceiling of values) {
        const side = (value: number | undefined): Pick<ComposedBudget, Dimension> => (value === undefined ? {} : { tokens: value, costUsd: value, timeMs: value });
        const composed = composeBudget({ steps: 3, retries: 2, ...side(declared) }, side(ceiling));
        const expected = declared === undefined ? ceiling : ceiling === undefined ? declared : Math.min(declared, ceiling);
        for (const dimension of CEILED) expect(composed[dimension]).toBe(expected);
        expect(composed).toMatchObject({ steps: 3, retries: 2 });
      }
    }
  });

  it(
    'B8 composition: the effective budget of each ceiled dimension is present when either side is, and is within both the mandate and the ceiling',
    async () => {
      const arith = proofArith(z3.engine().api, 'B8-composition');
      const { ctx } = arith;
      const declared = counted(arith, 'declared');
      const ceiling = counted(arith, 'ceiling');
      const declaredPresent = ctx.Bool.const('declaredPresent');
      const ceilingPresent = ctx.Bool.const('ceilingPresent');
      const present = ctx.Or(declaredPresent, ceilingPresent);
      const effective = ctx.If(declaredPresent, ctx.If(ceilingPresent, arith.min(declared, ceiling), declared), ceiling) as ProofInt;
      const goal = ctx.Implies(
        present,
        ctx.And(ctx.Implies(declaredPresent, effective.le(declared)), ctx.Implies(ceilingPresent, effective.le(ceiling)), ctx.Or(effective.eq(declared), effective.eq(ceiling))),
      );
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  const TREE_RUNS = 3;

  type TreeState = { readonly spent: readonly ProofInt[]; readonly reserved: readonly ProofInt[]; readonly ended: readonly ProofBool[] };

  const treeOf = (arith: ProofArith, prefix: string): TreeState => ({
    spent: Array.from({ length: TREE_RUNS }, (_unused, index) => counted(arith, `${prefix}spent${index}`)),
    reserved: Array.from({ length: TREE_RUNS }, (_unused, index) => counted(arith, `${prefix}reserved${index}`)),
    ended: Array.from({ length: TREE_RUNS }, (_unused, index) => arith.ctx.Bool.const(`${prefix}ended${index}`)),
  });

  const heldReservations = (arith: ProofArith, tree: TreeState, except: number | undefined): ProofInt =>
    sum(tree.reserved.map((reserved, index) => (index === except ? arith.ctx.Int.val(0) : (arith.ctx.If(tree.ended[index] as ProofBool, arith.ctx.Int.val(0), reserved) as ProofInt))));

  const treeTotal = (arith: ProofArith, tree: TreeState): ProofInt => sum(tree.spent).add(heldReservations(arith, tree, undefined));

  const admitInTree = (arith: ProofArith, tree: TreeState, runIndex: number, label: string, readsTree: boolean): { ask: AskTerms; admission: AdmissionTerms; after: TreeState } => {
    const { ctx } = arith;
    const ask = askOf(arith, `${label}.`);
    const spend: SpendTerms = readsTree
      ? { totalTokens: ctx.Int.val(0), reservedTokens: ctx.Int.val(0), costNano: sum(tree.spent), reservedNano: heldReservations(arith, tree, runIndex) }
      : { totalTokens: ctx.Int.val(0), reservedTokens: ctx.Int.val(0), costNano: tree.spent[runIndex] as ProofInt, reservedNano: ctx.Int.val(0) };
    const admission = admissionOf(arith, ask, spend, { tokens: false, cost: true }, label);
    arith.given(ctx.Not(tree.ended[runIndex] as ProofBool), admission.admitted);
    const after = { ...tree, reserved: tree.reserved.map((reserved, index) => (index === runIndex ? admission.reservedNano : reserved)) };
    return { ask, admission, after };
  };

  it(
    'reads the tree spend of the store at a parent and a child: a child is admitted against the parent reservation it reads, as the encoding of the tree admits it',
    async () => {
      const h = harness();
      const parent = await enqueue(h.store, newSession(h.store).id);
      const parentClaim = mustClaim(h.store, 'w-parent');
      const child = await spawnChild(h.store, parent.id);
      const childClaim = mustClaim(h.store, 'w-child');
      expect(childClaim.runId).toBe(child);
      const ask: AdmissionAsk = { inputUpper: 1000, outputWanted: 4000, outputFloor: 256, price: PRICE, limits: { costNano: 100_000 } };
      const first = h.store.admitModelRequest(parentClaim, ask);
      const second = h.store.admitModelRequest(childClaim, ask);
      const again = h.store.admitModelRequest(childClaim, ask);
      if (first.kind !== 'admitted' || second.kind !== 'admitted' || again.kind !== 'admitted') throw new Error('expected three admissions');
      const arith = proofArith(z3.engine().api, 'tree-sample');
      const tree = treeOf(arith, '');
      arith.given(...tree.ended.map((ended) => arith.ctx.Not(ended)));
      const { admission } = admitInTree(arith, tree, 1, 'child', true);
      const values = await valuesAt(
        arith,
        { spent0: 0n, spent1: 0n, spent2: 0n, reserved0: BigInt(first.reservedNano), reserved1: BigInt(second.reservedNano), reserved2: 0n, ...prefixed('child.', fixedOf({ ask, spend: NO_SPEND })) },
        { cap: admission.cap, reservedNano: admission.reservedNano },
      );
      expect([values['cap'], values['reservedNano']]).toEqual([String(again.maxOutputTokens), String(again.reservedNano)]);
      const spend = h.store.treeSpend(parent.id);
      expect(spend.reservedNano).toBe(first.reservedNano + again.reservedNano);
      expect(spend.runsRead).toBe(2);
      expect(mustRun(h.store, child).parentRunId).toBe(parent.id);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'tree conservation: whatever the tree held, an admission that reads the whole tree, replacing its own reservation, leaves the spend plus every live reservation within its limit, and two admissions in turn stay within it',
    async () => {
      const arith = proofArith(z3.engine().api, 'tree-conservation');
      const { ctx } = arith;
      const tree = treeOf(arith, '');
      const first = admitInTree(arith, tree, 1, 'first', true);
      const second = admitInTree(arith, first.after, 2, 'second', true);
      arith.given(first.ask.costLimit.eq(second.ask.costLimit));
      const goal = ctx.And(treeTotal(arith, first.after).le(first.ask.costLimit), treeTotal(arith, second.after).le(second.ask.costLimit));
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'ceiling induction: recording the charge of a response within its admission and clearing its reservation, or ending a run, keeps the tree within the limit',
    async () => {
      const arith = proofArith(z3.engine().api, 'ceiling-induction');
      const { ctx } = arith;
      const limit = counted(arith, 'limit');
      const tree = treeOf(arith, '');
      const charge = counted(arith, 'charge');
      arith.given(treeTotal(arith, tree).le(limit), charge.le(tree.reserved[0] as ProofInt), ctx.Not(tree.ended[0] as ProofBool));
      const charged: TreeState = {
        spent: tree.spent.map((spent, index) => (index === 0 ? spent.add(charge) : spent)),
        reserved: tree.reserved.map((reserved, index) => (index === 0 ? ctx.Int.val(0) : reserved)),
        ended: tree.ended,
      };
      const ended: TreeState = { ...tree, ended: tree.ended.map((flag, index) => (index === 0 ? ctx.Bool.val(true) : flag)) };
      expect(await hypothesesSatisfiable(arith)).toBe(true);
      expect(await prove(arith, ctx.And(treeTotal(arith, charged).le(limit), treeTotal(arith, ended).le(limit)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'evidence: an admission that reads only the spend of its own run lets two runs of one tree together pass the limit',
    async () => {
      const arith = proofArith(z3.engine().api, 'tree-own-spend');
      const tree = treeOf(arith, '');
      const first = admitInTree(arith, tree, 1, 'first', false);
      const second = admitInTree(arith, first.after, 2, 'second', false);
      arith.given(first.ask.costLimit.eq(second.ask.costLimit), ...tree.reserved.map((reserved) => reserved.eq(0)));
      const model = await expectRefuted(arith, treeTotal(arith, second.after).le(second.ask.costLimit));
      expect(BigInt(model['second.costLimit'] as string)).toBeGreaterThanOrEqual(0n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

const prefixed = (prefix: string, fixed: Record<string, bigint>): Record<string, bigint> =>
  Object.fromEntries(
    Object.entries(fixed)
      .filter(([name]) => !['totalTokens', 'spendReservedTokens', 'costNano', 'spendReservedNano'].includes(name))
      .map(([name, value]) => [`${prefix}${name}`, value]),
  );

const spawnChild = async (store: RuntimeStore, parentId: string): Promise<string> => {
  const result = await store.createChildRun({ parentRunId: parentId, parentCallId: 'call-1', input: 'child task', pins: { agent: { name: 'helper' } }, model: 'fm' });
  if (result.kind !== 'created') throw new Error(`expected a child run, got ${result.kind}`);
  return result.run.id;
};
