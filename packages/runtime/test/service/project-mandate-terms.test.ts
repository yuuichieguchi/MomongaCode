import { describe, expect, it } from 'vitest';
import type { ProjectMandate } from '@momonga/config';
import { runTermsOf } from '../../src/service/delegation.ts';
import type { DelegationSettings, RunTermsRequest } from '../../src/service/delegation.ts';

const DEFAULTS = { runTimeoutMs: 3_600_000, limits: { maxSteps: 50, maxTotalTokens: 1_000_000, approvalTtlMs: 1_800_000, loopThreshold: 3 } };

const SETTINGS: DelegationSettings = {
  mandates: { nightly: { allow: ['GitCommit', 'GitPush(origin:feature/*)'], ask: ['GitPush(origin:main)'], deny: ['Bash(rm:*)'], until: ['npm test'], steps: 30, tokens: 400_000, timeMs: 1_800_000 } },
};

const terms = (request: RunTermsRequest, project: ProjectMandate | undefined, reads: { count: number } = { count: 0 }) =>
  runTermsOf({
    request,
    defaults: DEFAULTS,
    settings: SETTINGS,
    project: async () => {
      reads.count += 1;
      return project;
    },
    billing: async () => ({ metered: false, priced: true }),
  });

describe('the project mandate file layered on the mandate of a run', () => {
  it('adds its ask and deny rules and its completion conditions, and leaves the allow rules as the user declared them', async () => {
    const result = await terms({ mandate: { profile: 'nightly' } }, { ask: ['GitPush(origin:feature/*)'], deny: ['Bash(curl:*)'], until: ['npm run lint'], require: ['the changelog is updated'] });
    expect(result.mandate?.scope).toEqual({
      allow: ['GitCommit', 'GitPush(origin:feature/*)'],
      ask: ['GitPush(origin:main)', 'GitPush(origin:feature/*)'],
      deny: ['Bash(rm:*)', 'Bash(curl:*)'],
    });
    expect(result.mandate?.completion).toEqual({ conditions: [{ command: 'npm test' }, { command: 'npm run lint' }], requirements: ['the changelog is updated'] });
  });

  it('can only make a budget smaller: the smaller of the two values is the limit of the run', async () => {
    const result = await terms({ mandate: { profile: 'nightly' } }, { steps: 10, tokens: 900_000, timeMs: 60_000, retries: 2 });
    expect(result.limits).toMatchObject({ maxSteps: 10, maxTotalTokens: 400_000, maxFailedAttempts: 2 });
    expect(result.timeoutMs).toBe(60_000);
  });

  it('changes nothing when the folder declares none', async () => {
    const withFile = await terms({ mandate: { profile: 'nightly' } }, undefined);
    const without = await runTermsOf({ request: { mandate: { profile: 'nightly' } }, defaults: DEFAULTS, settings: SETTINGS, billing: async () => ({ metered: false, priced: true }) });
    expect(withFile).toEqual(without);
  });

  it('is not read for a run without a mandate, and does not make one', async () => {
    const reads = { count: 0 };
    const result = await terms({ limits: { maxSteps: 5 } }, { deny: ['Bash(curl:*)'], steps: 1 }, reads);
    expect(result).toEqual({ limits: { ...DEFAULTS.limits, maxSteps: 5 }, timeoutMs: 3_600_000 });
    expect(reads.count).toBe(0);
  });

  it('is not read for a mandate that only declares completion, which has no scope to narrow', async () => {
    const reads = { count: 0 };
    await terms({ mandate: { completion: { conditions: [{ command: 'npm test' }] } } }, { deny: ['Bash(curl:*)'] }, reads);
    expect(reads.count).toBe(0);
  });
});
