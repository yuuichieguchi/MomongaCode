import { MIN_ITEM_CAP, MIN_ROOM_TOKENS } from '@momonga/context';
import {
  COMPACT_AT,
  EVICT_LOW_WATER,
  ITEM_CAP,
  ITEM_ROOM,
  MARGIN,
  MAX_OUTPUT_WINDOW,
  MIN_MARGIN,
  OUTPUT_RESERVE,
} from '@momonga/protocol';
import type { ErrorBound, ProofArith, ProofBool, ProofInt } from '../support/proofs/arith.ts';

export type Ratio = { readonly num: number; readonly den: number };

export const MAX_WINDOW = 2n ** 33n;
export const MIN_OUTPUT_RESERVE = 256;

export const ceilOf = (arith: ProofArith, ratio: Ratio, value: ProofInt): ProofInt =>
  arith.ceilDiv(value.mul(arith.ctx.Int.val(BigInt(ratio.num))), BigInt(ratio.den));

export const floorOf = (arith: ProofArith, ratio: Ratio, value: ProofInt): ProofInt =>
  arith.floorDiv(value.mul(arith.ctx.Int.val(BigInt(ratio.num))), BigInt(ratio.den));

export const hypothesesSatisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

export const named = (arith: ProofArith, name: string, value: ProofInt): ProofInt => {
  const variable = arith.int(name);
  arith.given(variable.eq(value));
  return variable;
};

export type Window = {
  readonly W: ProofInt;
  readonly maxOutput: ProofInt;
  readonly R: ProofInt;
  readonly margin: ProofInt;
  readonly I0: ProofInt;
};

export const windowOf = (arith: ProofArith): Window => {
  const { ctx } = arith;
  const W = arith.int('W');
  const maxOutput = arith.int('maxOutput');
  arith.given(W.ge(1), W.le(ctx.Int.val(MAX_WINDOW)), maxOutput.ge(1), maxOutput.le(W));
  const reserve = arith.min(
    arith.min(maxOutput, arith.max(ctx.Int.val(MIN_OUTPUT_RESERVE), ceilOf(arith, OUTPUT_RESERVE, W))),
    floorOf(arith, MAX_OUTPUT_WINDOW, W),
  );
  const R = named(arith, 'R', reserve);
  const margin = named(arith, 'margin', arith.max(ceilOf(arith, MARGIN, W), ctx.Int.val(MIN_MARGIN)));
  const I0 = named(arith, 'I0', arith.max(ctx.Int.val(0), W.sub(R).sub(margin)));
  return { W, maxOutput, R, margin, I0 };
};

export const unboundedWindowOf = (arith: ProofArith, options: { readonly loadRule: boolean }): Window => {
  const { ctx } = arith;
  const W = arith.int('W');
  const maxOutput = arith.int('maxOutput');
  arith.given(W.ge(1), W.le(ctx.Int.val(MAX_WINDOW)), maxOutput.ge(1), maxOutput.le(W));
  const R = named(arith, 'R', maxOutput);
  const margin = named(arith, 'margin', arith.max(ceilOf(arith, MARGIN, W), ctx.Int.val(MIN_MARGIN)));
  if (options.loadRule) arith.given(W.sub(R).sub(margin).ge(ceilOf(arith, OUTPUT_RESERVE, W)));
  const I0 = named(arith, 'I0', arith.max(ctx.Int.val(0), W.sub(R).sub(margin)));
  return { W, maxOutput, R, margin, I0 };
};

export const anyCeiling = (arith: ProofArith, window: Window): ProofInt => {
  const ceiling = arith.int('ceiling');
  arith.given(ceiling.ge(0), ceiling.le(window.I0));
  return ceiling;
};

export type Marks = {
  readonly F: ProofInt;
  readonly room: ProofInt;
  readonly maxInputB: ProofInt;
  readonly H: ProofInt;
  readonly L: ProofInt;
};

export const marksOf = (
  arith: ProofArith,
  window: Window,
  ceiling: ProofInt,
  b: ErrorBound,
  options: { readonly capped: boolean },
): Marks => {
  const { ctx } = arith;
  const F = arith.int('F');
  const maxInputB = arith.int('maxInputB');
  arith.given(F.ge(0), F.le(ceiling), F.add(b.at(F)).le(window.I0));
  const room = named(arith, 'room', ceiling.sub(F));
  arith.given(room.ge(ctx.Int.val(MIN_ROOM_TOKENS)));
  arith.given(maxInputB.ge(0), maxInputB.le(ceiling), maxInputB.add(b.at(maxInputB)).le(window.I0));
  arith.given(ctx.Implies(F.add(b.at(F)).le(window.I0), F.le(maxInputB)));
  const proactive = F.add(floorOf(arith, COMPACT_AT, room));
  const H = named(arith, 'H', options.capped ? arith.min(proactive, maxInputB) : proactive);
  const L = named(arith, 'L', F.add(floorOf(arith, EVICT_LOW_WATER, H.sub(F))));
  return { F, room, maxInputB, H, L };
};

export const b1Goal = (arith: ProofArith, ceiling: ProofInt, marks: Marks): ProofBool =>
  arith.ctx.And(marks.F.le(marks.H), marks.H.le(ceiling), marks.F.le(marks.L), marks.L.le(marks.H));

export const b4Goal = (arith: ProofArith, window: Window, ceiling: ProofInt, marks: Marks, b: ErrorBound): ProofBool => {
  b.monotone(marks.H, marks.maxInputB);
  return arith.ctx.And(marks.F.le(marks.H), marks.H.le(ceiling), marks.H.add(b.at(marks.H)).le(window.I0));
};

export const b2FitGoal = (arith: ProofArith, window: Window, marks: Marks, b: ErrorBound): ProofBool => {
  const total = arith.int('total');
  arith.given(total.ge(0), total.le(marks.H));
  b.monotone(total, marks.maxInputB);
  return total.add(b.at(total)).le(window.I0);
};

export const b2StepGoal = (arith: ProofArith, marks: Marks): ProofBool => {
  const g = arith.int('g');
  const before = arith.int('totalBefore');
  const after = arith.int('totalAfter');
  arith.given(g.ge(1), before.ge(0), after.ge(0), before.le(marks.H.sub(g)), after.le(before.add(g)));
  return after.le(marks.H);
};

export type ToolFloor = { readonly room: ProofInt; readonly itemCap: ProofInt };

export const toolFloorOf = (arith: ProofArith, window: Window, ceiling: ProofInt): ToolFloor => {
  const { ctx } = arith;
  const F = arith.int('F');
  const pinnedFloor = named(arith, 'pinnedFloor', ceiling.sub(arith.max(ctx.Int.val(MIN_ROOM_TOKENS), ceilOf(arith, ITEM_CAP, ceiling))));
  arith.given(F.ge(0), F.le(pinnedFloor));
  const room = named(arith, 'room', ceiling.sub(F));
  const base = arith.max(ctx.Int.val(MIN_ITEM_CAP), floorOf(arith, ITEM_CAP, window.I0));
  const itemCap = named(arith, 'itemCap', arith.max(ctx.Int.val(MIN_ITEM_CAP), arith.min(base, floorOf(arith, ITEM_ROOM, room))));
  return { room, itemCap };
};

export const b7Goal = (arith: ProofArith, floor: ToolFloor): ProofBool => {
  const { ctx } = arith;
  return ctx.And(
    floor.room.ge(ctx.Int.val(MIN_ROOM_TOKENS)),
    floor.itemCap.ge(ctx.Int.val(MIN_ITEM_CAP)),
    floor.itemCap.le(floorOf(arith, ITEM_ROOM, floor.room)),
  );
};

export type ChainMember = { readonly window: ProofInt; readonly maxOutput: ProofInt };

export type ChainWindow = Window & { readonly members: readonly ChainMember[] };

export const CHAIN_MEMBERS = 3;

export const chainWindowOf = (arith: ProofArith, options: { readonly loadRule: boolean }): ChainWindow => {
  const { ctx } = arith;
  const members = Array.from({ length: CHAIN_MEMBERS }, (_unused, index): ChainMember => {
    const window = arith.int(`W${index}`);
    const maxOutput = arith.int(`M${index}`);
    arith.given(window.ge(1), window.le(ctx.Int.val(MAX_WINDOW)), maxOutput.ge(1), maxOutput.le(window));
    return { window, maxOutput };
  });
  const smallest = members.slice(1).reduce((least, member) => arith.min(least, member.window), (members[0] as ChainMember).window);
  const largest = members.slice(1).reduce((most, member) => arith.max(most, member.maxOutput), (members[0] as ChainMember).maxOutput);
  const W = named(arith, 'W', smallest);
  const U = named(arith, 'U', largest);
  const margin = named(arith, 'margin', arith.max(ceilOf(arith, MARGIN, W), ctx.Int.val(MIN_MARGIN)));
  if (options.loadRule) arith.given(W.sub(U).sub(margin).ge(ceilOf(arith, OUTPUT_RESERVE, W)));
  const I0 = named(arith, 'I0', arith.max(ctx.Int.val(0), W.sub(U).sub(margin)));
  return { W, maxOutput: U, R: U, margin, I0, members };
};
