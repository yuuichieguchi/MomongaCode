import { describe, expect, it } from 'vitest';
import { declaredMandateOf, runTermsOf } from '../../src/service/delegation.ts';
import type { ChainBilling, DelegationSettings, RunTermsRequest } from '../../src/service/delegation.ts';

const DEFAULTS = { runTimeoutMs: 3_600_000, limits: { maxSteps: 50, maxTotalTokens: 1_000_000, approvalTtlMs: 1_800_000, loopThreshold: 3 } };

const LOCAL: ChainBilling = { metered: false, priced: true };
const PRICED: ChainBilling = { metered: true, priced: true };
const NO_PRICE: ChainBilling = { metered: true, priced: false };
const PLAN: ChainBilling = { metered: false, priced: false };

const terms = (request: RunTermsRequest, settings: DelegationSettings = {}, billing: ChainBilling = LOCAL) => runTermsOf({ request, defaults: DEFAULTS, settings, billing: async () => billing });

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the request to be refused');
};

describe('the terms of a run without a mandate', () => {
  it('are the defaults with the limits of the request over them', async () => {
    expect(await terms({ limits: { maxSteps: 5 } })).toEqual({ limits: { ...DEFAULTS.limits, maxSteps: 5 }, timeoutMs: 3_600_000 });
  });

  it('take the standing money limit of the user settings, and the one of the request before it', async () => {
    expect((await terms({}, { limits: { maxCostUsd: 2 } }, PRICED)).limits).toMatchObject({ maxCostUsd: 2 });
    expect((await terms({ limits: { maxCostUsd: 0.5 } }, { limits: { maxCostUsd: 2 } }, PRICED)).limits).toMatchObject({ maxCostUsd: 0.5 });
  });

  it('refuse a money limit on a chain that has no price, naming the remedy', async () => {
    expect(await refusal(terms({ limits: { maxCostUsd: 1 } }, {}, NO_PRICE))).toContain('has no price');
    expect(await refusal(terms({ limits: { maxCostUsd: 1 } }, {}, PLAN))).toContain('add its price under pricing');
  });

  it('keep a mandate that only declares completion as it was sent, with no scope', async () => {
    const mandate = { completion: { conditions: [{ command: 'npm test' }] } };
    expect(await terms({ mandate })).toMatchObject({ mandate });
  });
});

describe('a mandate declared by name', () => {
  const settings: DelegationSettings = {
    mandates: {
      nightly: { allow: ['Bash(npm test:*)', 'GitCommit'], ask: ['GitPush(origin:main)'], deny: ['Bash(rm:*)'], until: ['npm test'], require: ['the changelog is updated'], steps: 30, tokens: 400_000, costUsd: 3, timeMs: 7_200_000, retries: 2, onQuiescent: 'report' },
    },
  };

  it('is read from the user settings: scope, budget, completion and hold', () => {
    expect(declaredMandateOf({ profile: 'nightly' }, settings)).toEqual({
      completion: { conditions: [{ command: 'npm test' }], requirements: ['the changelog is updated'] },
      scope: { allow: ['Bash(npm test:*)', 'GitCommit'], ask: ['GitPush(origin:main)'], deny: ['Bash(rm:*)'] },
      budget: { steps: 30, tokens: 400_000, costUsd: 3, timeMs: 7_200_000, retries: 2 },
      hold: { onQuiescent: 'report' },
    });
  });

  it('takes what the request adds: more rules, more conditions, its own budget figures', () => {
    const declared = declaredMandateOf({ profile: 'nightly', scope: { deny: ['GitPush'] }, budget: { costUsd: 1 }, completion: { conditions: [{ command: 'npm run lint' }] } }, settings);
    expect(declared?.scope?.deny).toEqual(['Bash(rm:*)', 'GitPush']);
    expect(declared?.budget).toMatchObject({ costUsd: 1, steps: 30 });
    expect(declared?.completion?.conditions).toEqual([{ command: 'npm run lint' }, { command: 'npm test' }]);
  });

  it('becomes the limits and the deadline of the run, and is stored without its budget', async () => {
    const result = await terms({ mandate: { profile: 'nightly' } }, settings, PRICED);
    expect(result.limits).toEqual({ ...DEFAULTS.limits, maxSteps: 30, maxTotalTokens: 400_000, maxCostUsd: 3, maxFailedAttempts: 2 });
    expect(result.timeoutMs).toBe(7_200_000);
    expect(result.mandate).toEqual({
      completion: { conditions: [{ command: 'npm test' }], requirements: ['the changelog is updated'] },
      scope: { allow: ['Bash(npm test:*)', 'GitCommit'], ask: ['GitPush(origin:main)'], deny: ['Bash(rm:*)'] },
      hold: { onQuiescent: 'report' },
    });
  });

  it('is capped by the ceilings of the user, dimension by dimension', async () => {
    const result = await terms({ mandate: { profile: 'nightly' } }, { ...settings, ceilings: { costUsd: 1.5, tokens: 100_000, timeMs: 600_000 } }, PRICED);
    expect(result.limits).toMatchObject({ maxCostUsd: 1.5, maxTotalTokens: 100_000, maxSteps: 30 });
    expect(result.timeoutMs).toBe(600_000);
  });

  it('is refused when no mandate has that name, listing the declared names', async () => {
    expect(await refusal(terms({ mandate: { profile: 'weekly' } }, settings))).toBe('no mandate named "weekly" is declared in the user settings (declared: nightly)');
  });
});

describe('what a mandate must declare before the run is created', () => {
  const scope = { allow: ['GitCommit'] };

  it('needs a money budget on a model billed by use', async () => {
    expect(await refusal(terms({ mandate: { scope } }, {}, PRICED))).toContain('needs a money budget');
    expect((await terms({ mandate: { scope, budget: { costUsd: 2 } } }, {}, PRICED)).limits).toMatchObject({ maxCostUsd: 2 });
  });

  it('takes the ceiling of the user as the money budget when it declares none', async () => {
    expect((await terms({ mandate: { scope } }, { ceilings: { costUsd: 4 } }, PRICED)).limits).toMatchObject({ maxCostUsd: 4 });
  });

  it('needs none on a local model, and none on a model billed by a plan', async () => {
    expect((await terms({ mandate: { scope } }, {}, LOCAL)).mandate).toEqual({ scope });
    expect((await terms({ mandate: { scope } }, {}, PLAN)).mandate).toEqual({ scope });
  });

  it('is refused with a money budget on a chain that has no price', async () => {
    expect(await refusal(terms({ mandate: { scope, budget: { costUsd: 2 } } }, {}, NO_PRICE))).toContain('has no price');
  });

  it('is refused when a rule of its scope is not a permission rule, naming the rule', async () => {
    expect(await refusal(terms({ mandate: { scope: { allow: ['Bash('] } } }))).toContain('the allow rule "Bash(" of the mandate is not a permission rule');
  });
});
