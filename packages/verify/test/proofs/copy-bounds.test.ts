import { describe, expect, it } from 'vitest';
import { proofArith } from '../support/proofs/arith.ts';
import { prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { SCREEN_CONSTANTS, base64LengthWith, numberOps, proofOps } from './screen-model.ts';

describe('copy bounds (design/cli-tui.md section 15.4): the OSC 52 payload and the copied extract, tied to packages/cli/src/tui/screen/clipboard.ts and selection.ts by test/screen-proofs-drift.test.ts', () => {
  const z3 = useZ3();

  it('reads the base64 length of the model against the encoder at sampled sizes', () => {
    for (const size of [0, 1, 2, 3, 4, 5, 6, 99_999, SCREEN_CONSTANTS.OSC52_MAX_RAW_BYTES]) {
      expect(base64LengthWith(numberOps, size)).toBe(Buffer.alloc(size, 0xff).toString('base64').length);
    }
  });

  it(
    'gives n raw bytes 4 ceil(n / 3) base64 bytes, monotone in n, so a payload within OSC52_MAX_RAW_BYTES is within the encoded bound',
    async () => {
      const arith = proofArith(z3.engine().api, 'copy-osc52');
      const { ctx } = arith;
      const ops = proofOps(arith);
      const size = arith.int('n');
      const larger = arith.int('m');
      arith.given(size.ge(0), larger.ge(size));
      const length = base64LengthWith(ops, size);
      const bound = base64LengthWith(ops, ctx.Int.val(SCREEN_CONSTANTS.OSC52_MAX_RAW_BYTES));
      const goal = ctx.And(
        length.eq(arith.ceilDiv(size, 3n).mul(4)),
        length.le(base64LengthWith(ops, larger)),
        ctx.Implies(size.le(SCREEN_CONSTANTS.OSC52_MAX_RAW_BYTES), length.le(bound)),
        bound.eq(4 * Math.ceil(SCREEN_CONSTANTS.OSC52_MAX_RAW_BYTES / 3)),
      );
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'keeps an extract that stops at COPY_MAX_BYTES within it: a piece is kept only while the running count stays within the cap',
    async () => {
      const arith = proofArith(z3.engine().api, 'copy-extract');
      const { ctx } = arith;
      const kept = arith.int('kept');
      const piece = arith.int('piece');
      const cap = ctx.Int.val(SCREEN_CONSTANTS.COPY_MAX_BYTES);
      arith.given(kept.ge(0), kept.le(cap), piece.ge(0));
      const counted = kept.add(piece);
      const next = ctx.If(counted.gt(cap), kept, counted);
      expect(await prove(arith, ctx.And(next.ge(0), next.le(cap)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
