import { PRICE_UNITS_PER_NANO } from '@momonga/protocol';
import type { ProofArith, ProofBool, ProofInt } from '../support/proofs/arith.ts';

export const LARGEST_COUNTED = 2n ** 53n - 1n;

export type Presence = { readonly tokens: boolean; readonly cost: boolean };

export const PRESENCES: readonly Presence[] = [
  { tokens: false, cost: true },
  { tokens: true, cost: false },
  { tokens: true, cost: true },
];

export type AskTerms = {
  readonly inputUpper: ProofInt;
  readonly outputWanted: ProofInt;
  readonly outputFloor: ProofInt;
  readonly inUnits: ProofInt;
  readonly outUnits: ProofInt;
  readonly tokenLimit: ProofInt;
  readonly costLimit: ProofInt;
};

export type SpendTerms = {
  readonly totalTokens: ProofInt;
  readonly reservedTokens: ProofInt;
  readonly costNano: ProofInt;
  readonly reservedNano: ProofInt;
};

export type AdmissionTerms = {
  readonly admitted: ProofBool;
  readonly floor: ProofInt;
  readonly cap: ProofInt;
  readonly reservedTokens: ProofInt;
  readonly reservedNano: ProofInt;
  readonly heldTokens: ProofInt;
  readonly heldNano: ProofInt;
  readonly tokenRoom: ProofInt;
  readonly availableUnits: ProofInt;
  readonly inputUnits: ProofInt;
};

export const counted = (arith: ProofArith, name: string): ProofInt => {
  const variable = arith.int(name);
  arith.given(variable.ge(0), variable.le(arith.ctx.Int.val(LARGEST_COUNTED)));
  return variable;
};

export const askOf = (arith: ProofArith, prefix = ''): AskTerms => ({
  inputUpper: counted(arith, `${prefix}inputUpper`),
  outputWanted: counted(arith, `${prefix}outputWanted`),
  outputFloor: counted(arith, `${prefix}outputFloor`),
  inUnits: counted(arith, `${prefix}inUnits`),
  outUnits: counted(arith, `${prefix}outUnits`),
  tokenLimit: counted(arith, `${prefix}tokenLimit`),
  costLimit: counted(arith, `${prefix}costLimit`),
});

export const spendOf = (arith: ProofArith, prefix = ''): SpendTerms => ({
  totalTokens: counted(arith, `${prefix}totalTokens`),
  reservedTokens: counted(arith, `${prefix}spendReservedTokens`),
  costNano: counted(arith, `${prefix}costNano`),
  reservedNano: counted(arith, `${prefix}spendReservedNano`),
});

export const worstUnitsOf = (inputUpper: ProofInt, outputCap: ProofInt, ask: Pick<AskTerms, 'inUnits' | 'outUnits'>): ProofInt =>
  inputUpper.mul(ask.inUnits).add(outputCap.mul(ask.outUnits));

export const nanoOfUnitsOf = (arith: ProofArith, units: ProofInt): ProofInt => arith.ceilDiv(units, PRICE_UNITS_PER_NANO);

const fittingOf = (arith: ProofArith, room: ProofInt, outUnits: ProofInt, label: string): ProofInt => {
  const fitting = arith.int(label);
  arith.given(arith.ctx.Implies(outUnits.gt(0), arith.ctx.And(fitting.mul(outUnits).le(room), fitting.add(1).mul(outUnits).gt(room))));
  return fitting;
};

export const admissionOf = (arith: ProofArith, ask: AskTerms, spend: SpendTerms, presence: Presence, label = 'admission'): AdmissionTerms => {
  const { ctx } = arith;
  const floor = arith.min(ask.outputWanted, ask.outputFloor);
  const heldTokens = spend.totalTokens.add(spend.reservedTokens);
  const tokenRoom = ask.tokenLimit.sub(heldTokens).sub(ask.inputUpper);
  const tokensFit = presence.tokens ? tokenRoom.ge(floor) : ctx.Bool.val(true);
  const tokenCap = presence.tokens ? arith.min(ask.outputWanted, tokenRoom) : ask.outputWanted;
  const heldNano = spend.costNano.add(spend.reservedNano);
  const availableUnits = ask.costLimit.sub(heldNano).mul(ctx.Int.val(PRICE_UNITS_PER_NANO));
  const inputUnits = ask.inputUpper.mul(ask.inUnits);
  const outputRoom = availableUnits.sub(inputUnits);
  const fitting = fittingOf(arith, outputRoom, ask.outUnits, `${label}.fitting`);
  const costFits = presence.cost ? ctx.And(outputRoom.ge(0), ctx.Implies(ask.outUnits.gt(0), fitting.ge(floor))) : ctx.Bool.val(true);
  const cap = presence.cost ? (ctx.If(ask.outUnits.gt(0), arith.min(tokenCap, fitting), tokenCap) as ProofInt) : tokenCap;
  const reservedNano = presence.cost ? nanoOfUnitsOf(arith, worstUnitsOf(ask.inputUpper, cap, ask)) : ctx.Int.val(0);
  return {
    admitted: ctx.And(tokensFit, costFits),
    floor,
    cap,
    reservedTokens: ask.inputUpper.add(cap),
    reservedNano,
    heldTokens,
    heldNano,
    tokenRoom,
    availableUnits,
    inputUnits,
  };
};

export const valuesAt = async (arith: ProofArith, fixed: Readonly<Record<string, bigint>>, terms: Readonly<Record<string, ProofInt | ProofBool>>): Promise<Record<string, string>> => {
  const { ctx } = arith;
  const variables = arith.variables();
  const solver = new ctx.Solver();
  solver.add(...arith.assertions());
  for (const [name, value] of Object.entries(fixed)) {
    const variable = variables.get(name);
    if (variable === undefined) throw new Error(`the proof ${arith.name} has no variable ${name}`);
    solver.add(variable.eq(ctx.Int.val(value)));
  }
  const status = await solver.check();
  if (status !== 'sat') throw new Error(`the proof ${arith.name} has no model at ${JSON.stringify(Object.fromEntries(Object.entries(fixed).map(([key, value]) => [key, String(value)])))}: ${status}`);
  const model = solver.model();
  return Object.fromEntries(Object.entries(terms).map(([name, term]) => [name, model.eval(term, true).toString()]));
};
