import type { Arith, Bool, Context } from 'z3-solver';
import type { Z3Api } from '../../../src/smt.ts';

export type ProofInt = Arith<'main'>;

export type ProofBool = Bool<'main'>;

export type ErrorBound = {
  at(point: ProofInt): ProofInt;
  monotone(first: ProofInt, second: ProofInt): void;
};

export type ProofArith = {
  readonly name: string;
  readonly ctx: Context<'main'>;
  int(name: string): ProofInt;
  given(...constraints: readonly ProofBool[]): void;
  min(first: ProofInt, second: ProofInt): ProofInt;
  max(first: ProofInt, second: ProofInt): ProofInt;
  ceilDiv(numerator: ProofInt, denominator: bigint): ProofInt;
  floorDiv(numerator: ProofInt, denominator: bigint): ProofInt;
  ceilRatio(ratio: number, value: ProofInt): ProofInt;
  floorRatio(ratio: number, value: ProofInt): ProofInt;
  errorBound(name: string): ErrorBound;
  assertions(): readonly ProofBool[];
  variables(): ReadonlyMap<string, ProofInt>;
};

const gcd = (first: bigint, second: bigint): bigint => (second === 0n ? first : gcd(second, first % second));

export const fractionOf = (ratio: number): readonly [numerator: bigint, denominator: bigint] => {
  const text = String(ratio);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) throw new Error(`the ratio ${text} is not a positive decimal number`);
  const fraction = match[2] ?? '';
  const numerator = BigInt(`${match[1]}${fraction}`);
  const denominator = 10n ** BigInt(fraction.length);
  if (numerator === 0n) throw new Error('the ratio must be positive');
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
};

export const proofArith = (api: Z3Api, name: string): ProofArith => {
  const ctx = new api.Context('main');
  const constraints: ProofBool[] = [];
  const declared = new Map<string, ProofInt>();
  let auxiliaries = 0;

  const aux = (label: string): ProofInt => ctx.Int.const(`${label}#${(auxiliaries += 1)}`);

  const int = (variable: string): ProofInt => {
    if (declared.has(variable)) throw new Error(`the proof ${name} declares ${variable} twice`);
    const created = ctx.Int.const(variable);
    declared.set(variable, created);
    return created;
  };

  const given = (...added: readonly ProofBool[]): void => {
    constraints.push(...added);
  };

  const ceilDiv = (numerator: ProofInt, denominator: bigint): ProofInt => {
    if (denominator < 1n) throw new Error('the denominator must be positive');
    const quotient = aux('ceilDiv');
    const scaled = quotient.mul(ctx.Int.val(denominator));
    given(scaled.ge(numerator), scaled.sub(ctx.Int.val(denominator)).lt(numerator));
    return quotient;
  };

  const floorDiv = (numerator: ProofInt, denominator: bigint): ProofInt => {
    if (denominator < 1n) throw new Error('the denominator must be positive');
    const quotient = aux('floorDiv');
    const scaled = quotient.mul(ctx.Int.val(denominator));
    given(scaled.le(numerator), scaled.add(ctx.Int.val(denominator)).gt(numerator));
    return quotient;
  };

  const ratioOf = (divide: (numerator: ProofInt, denominator: bigint) => ProofInt) => (ratio: number, value: ProofInt): ProofInt => {
    const [numerator, denominator] = fractionOf(ratio);
    return divide(value.mul(ctx.Int.val(numerator)), denominator);
  };

  const errorBound = (boundName: string): ErrorBound => {
    const bound = ctx.Function.declare(boundName, ctx.Int.sort(), ctx.Int.sort());
    const at = (point: ProofInt): ProofInt => {
      const value = bound.call(point) as ProofInt;
      given(value.ge(0));
      return value;
    };
    return {
      at,
      monotone: (first, second) => {
        given(ctx.Implies(first.le(second), at(first).le(at(second))), ctx.Implies(second.le(first), at(second).le(at(first))));
      },
    };
  };

  return {
    name,
    ctx,
    int,
    given,
    min: (first, second) => ctx.If(first.le(second), first, second) as ProofInt,
    max: (first, second) => ctx.If(first.ge(second), first, second) as ProofInt,
    ceilDiv,
    floorDiv,
    ceilRatio: ratioOf(ceilDiv),
    floorRatio: ratioOf(floorDiv),
    errorBound,
    assertions: () => constraints,
    variables: () => declared,
  };
};
