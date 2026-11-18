import { describe, expect, it } from 'vitest';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';
import { ALLOCATION_REGIONS, SCREEN_CONSTANTS, allocateWith, inputRowsCapOf, menuRowsCapOf, proofOps, subagentRowsCapOf } from './screen-model.ts';
import type { Allocation, Requests } from './screen-model.ts';

const REQUEST_NAMES = ['waiting', 'inputRows', 'invitation', 'menu', 'subagents', 'footerSecond', 'lines'] as const;

const requestsOf = (arith: ProofArith, prefix: string): Requests<ProofInt> => {
  const entries = REQUEST_NAMES.map((name) => {
    const request = arith.int(`${prefix}${name}`);
    arith.given(request.ge(0));
    return [name, request] as const;
  });
  return Object.fromEntries(entries) as Requests<ProofInt>;
};

const heightOf = (arith: ProofArith): ProofInt => {
  const height = arith.int('H');
  arith.given(height.ge(SCREEN_CONSTANTS.MIN_ROWS));
  return height;
};

const total = (allocation: Allocation<ProofInt>): ProofInt => ALLOCATION_REGIONS.slice(1).reduce((sum, region) => sum.add(allocation[region]), allocation.viewport);

describe('screen rows (design/cli-tui.md sections 3.1 and 15.4): the allocation of allocate(H, requests), tied to packages/cli/src/tui/screen/layout.ts by test/screen-proofs-drift.test.ts', () => {
  const z3 = useZ3();

  for (const withPanel of [false, true]) {
    it(
      `gives the viewport at least one row, sums to the height and keeps each allocation within its request and its cap, ${withPanel ? 'with' : 'without'} a prompt panel`,
      async () => {
        const arith = proofArith(z3.engine().api, `screen-rows-${withPanel ? 'panel' : 'input'}`);
        const { ctx } = arith;
        const ops = proofOps(arith);
        const height = heightOf(arith);
        const requests = requestsOf(arith, '');
        const panel = withPanel ? arith.int('panel') : undefined;
        if (panel !== undefined) arith.given(panel.ge(0));
        const allocation = allocateWith(ops, height, requests, panel);
        const reservedInput = panel === undefined ? ctx.Int.val(SCREEN_CONSTANTS.INPUT_BOX_FRAME_ROWS + 1) : arith.min(panel, height.sub(SCREEN_CONSTANTS.PANEL_KEEPS_ROWS));
        const goal = ctx.And(
          allocation.viewport.ge(1),
          total(allocation).eq(height),
          ...ALLOCATION_REGIONS.map((region) => allocation[region].ge(0)),
          allocation.waiting.le(requests.waiting),
          allocation.subagents.le(arith.min(requests.subagents, subagentRowsCapOf(ops, height))),
          allocation.footer.le(requests.footerSecond.add(SCREEN_CONSTANTS.FOOTER_ROWS)),
          allocation.lines.le(requests.lines),
          allocation.menu.le(requests.invitation.add(arith.min(requests.menu, menuRowsCapOf(ops, height)))),
          allocation.input.le(reservedInput.add(arith.max(ctx.Int.val(0), arith.min(requests.inputRows, inputRowsCapOf(ops, height)).sub(1)))),
          panel === undefined ? ctx.Bool.val(true) : allocation.input.le(height.sub(SCREEN_CONSTANTS.PANEL_KEEPS_ROWS)),
        );
        expect(await prove(arith, goal)).toEqual({ status: 'proved' });
      },
      SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
    );
  }
  for (const withPanel of [false, true]) {
    it(
      `keeps the input box and every row below it where they are when only the waiting row, the menu or the rows above the input change, ${withPanel ? 'with' : 'without'} a prompt panel`,
      async () => {
        const arith = proofArith(z3.engine().api, `screen-rows-still-${withPanel ? 'panel' : 'input'}`);
        const { ctx } = arith;
        const ops = proofOps(arith);
        const height = heightOf(arith);
        const requests = requestsOf(arith, '');
        const changed = requestsOf(arith, 'changed-');
        for (const name of ['inputRows', 'subagents', 'footerSecond'] as const) arith.given(changed[name].eq(requests[name]));
        const panel = withPanel ? arith.int('panel') : undefined;
        if (panel !== undefined) arith.given(panel.ge(0));
        const before = allocateWith(ops, height, requests, panel);
        const after = allocateWith(ops, height, changed, panel);
        const goal = ctx.And(before.input.eq(after.input), before.footer.eq(after.footer), before.subagents.eq(after.subagents));
        expect(await prove(arith, goal)).toEqual({ status: 'proved' });
      },
      SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
    );
  }
});
