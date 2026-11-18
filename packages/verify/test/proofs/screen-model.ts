import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';

export const SCREEN_CONSTANTS = {
  MIN_ROWS: 6,
  INPUT_BOX_FRAME_ROWS: 2,
  SUBAGENT_ROWS_MAX: 5,
  FOOTER_ROWS: 1,
  VIEWPORT_ROWS: 1,
  PANEL_KEEPS_ROWS: 4,
  OSC52_MAX_RAW_BYTES: 100_000,
  COPY_MAX_BYTES: 1024 * 1024,
} as const;

export type Ops<T> = {
  readonly lit: (value: number) => T;
  readonly add: (first: T, second: T) => T;
  readonly sub: (first: T, second: T) => T;
  readonly min: (first: T, second: T) => T;
  readonly max: (first: T, second: T) => T;
  readonly floorDiv: (value: T, divisor: number) => T;
};

export const NUMBER_OPS: Ops<number> = {
  lit: (value) => value,
  add: (first, second) => first + second,
  sub: (first, second) => first - second,
  min: Math.min,
  max: Math.max,
  floorDiv: (value, divisor) => Math.floor(value / divisor),
};

export type Requests<T> = { header: T; waiting: T; inputRows: T; invitation: T; menu: T; subagents: T; footerSecond: T; lines: T };

export type Allocation<T> = { header: T; viewport: T; menu: T; waiting: T; lines: T; input: T; footer: T; subagents: T };

export const ALLOCATION_REGIONS = ['header', 'viewport', 'menu', 'waiting', 'lines', 'input', 'footer', 'subagents'] as const;

export const inputRowsCapOf = <T>(ops: Ops<T>, height: T): T => ops.max(ops.lit(1), ops.floorDiv(height, 3));

export const menuRowsCapOf = <T>(ops: Ops<T>, height: T): T => ops.floorDiv(height, 3);

export const subagentRowsCapOf = <T>(ops: Ops<T>, height: T): T => ops.min(ops.lit(SCREEN_CONSTANTS.SUBAGENT_ROWS_MAX), ops.floorDiv(height, 6));

export const allocateWith = <T>(ops: Ops<T>, height: T, requests: Requests<T>, panel: T | undefined): Allocation<T> => {
  const zero = ops.lit(0);
  const panelRows = panel === undefined ? undefined : ops.min(panel, ops.sub(height, ops.lit(SCREEN_CONSTANTS.PANEL_KEEPS_ROWS)));
  const reservedInput = panelRows ?? ops.lit(SCREEN_CONSTANTS.INPUT_BOX_FRAME_ROWS + 1);
  let left = ops.sub(ops.sub(ops.sub(height, ops.lit(SCREEN_CONSTANTS.FOOTER_ROWS)), ops.lit(SCREEN_CONSTANTS.VIEWPORT_ROWS)), reservedInput);
  const take = (request: T): T => {
    const given = ops.max(zero, ops.min(request, left));
    left = ops.sub(left, given);
    return given;
  };
  const inputExtra = panelRows === undefined ? take(ops.sub(ops.min(requests.inputRows, inputRowsCapOf(ops, height)), ops.lit(1))) : zero;
  const subagents = take(ops.min(requests.subagents, subagentRowsCapOf(ops, height)));
  const footerSecond = take(requests.footerSecond);
  const header = take(requests.header);
  const invitation = panelRows === undefined ? take(requests.invitation) : zero;
  const waiting = take(requests.waiting);
  const menu = ops.add(invitation, panelRows === undefined ? take(ops.min(requests.menu, menuRowsCapOf(ops, height))) : zero);
  const lines = panelRows === undefined ? take(requests.lines) : zero;
  return {
    header,
    viewport: ops.add(ops.lit(SCREEN_CONSTANTS.VIEWPORT_ROWS), left),
    menu,
    waiting,
    lines,
    input: ops.add(reservedInput, inputExtra),
    footer: ops.add(ops.lit(SCREEN_CONSTANTS.FOOTER_ROWS), footerSecond),
    subagents,
  };
};

export const base64LengthWith = <T>(ops: Ops<T> & { readonly mul: (value: T, factor: number) => T }, rawBytes: T): T => ops.mul(ops.floorDiv(ops.add(rawBytes, ops.lit(2)), 3), 4);

export const proofOps = (arith: ProofArith): Ops<ProofInt> & { readonly mul: (value: ProofInt, factor: number) => ProofInt } => ({
  lit: (value) => arith.ctx.Int.val(BigInt(value)),
  add: (first, second) => first.add(second),
  sub: (first, second) => first.sub(second),
  min: arith.min,
  max: arith.max,
  floorDiv: (value, divisor) => arith.floorDiv(value, BigInt(divisor)),
  mul: (value, factor) => value.mul(arith.ctx.Int.val(BigInt(factor))),
});

export const numberOps: Ops<number> & { readonly mul: (value: number, factor: number) => number } = { ...NUMBER_OPS, mul: (value, factor) => value * factor };
