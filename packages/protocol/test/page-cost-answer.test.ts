import { describe, expect, it } from 'vitest';
import { defineProductSchema } from '@momonga/foundation';
import { REPORT_SCHEMAS, unreportedOutsideRuns } from '@momonga/protocol';
import type { PageCostAnswer } from '@momonga/protocol';

const validate = defineProductSchema<PageCostAnswer>('report/PageCostAnswer.test', REPORT_SCHEMAS.PageCostAnswer);

const row = (runId: string, units: string) => ({ runId, calls: 1, notPriced: 0, legacyPrecisionCalls: 0, priced: [{ currency: 'USD' as const, priceVersion: 'v1', units }] });

const answer: PageCostAnswer = {
  runs: [row('run-1', '2000'), row('run-2', '0')],
  totals: { calls: 2, notPriced: 0, priced: [{ currency: 'USD', units: '2000' }] },
  unreported: ['run-2'],
};

describe('the cost answer of a page of sessions', () => {
  it('passes the closed schema with an unreported run of the page', () => {
    expect(validate(answer).valid).toBe(true);
    expect(unreportedOutsideRuns(answer)).toEqual([]);
  });

  it('refuses an unreported id that is not a run of the page, and an unknown field', () => {
    expect(unreportedOutsideRuns({ ...answer, unreported: ['run-9'] })).toEqual(['run-9']);
    expect(validate({ ...answer, extra: true }).valid).toBe(false);
  });
});
