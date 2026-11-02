import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as bounds from '../e2e/support/wait.ts';
import { daemonReadyBoundMs } from '../packages/cli/src/daemon/ensure-daemon.ts';
import * as policy from '../packages/cli/src/commands/policy.ts';

type DerivedBounds = { policyVerifyBoundMs?: () => Promise<number>; E2E_SOLVER_LOAD_ALLOWANCE_MS?: number };
type VerifyBudget = { VERIFY_BUDGET_MS?: number };

const sourceOf = (relative: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');

describe('the e2e bound of policy verify', () => {
  it('is the daemon ready bound, the solver load allowance and the overall verification budget', async () => {
    const { policyVerifyBoundMs, E2E_SOLVER_LOAD_ALLOWANCE_MS } = bounds as DerivedBounds;
    const { VERIFY_BUDGET_MS } = policy as VerifyBudget;

    expect(VERIFY_BUDGET_MS).toBeGreaterThan(0);
    expect(E2E_SOLVER_LOAD_ALLOWANCE_MS).toBeGreaterThan(0);
    expect(await policyVerifyBoundMs?.()).toBe((await daemonReadyBoundMs()) + (E2E_SOLVER_LOAD_ALLOWANCE_MS as number) + (VERIFY_BUDGET_MS as number));
  });

  it('no longer multiplies a query timeout by a hand-restated property count', () => {
    expect(Object.keys(bounds)).not.toContain('E2E_POLICY_VERIFY_PROPERTY_COUNT');
    expect(Object.keys(bounds)).not.toContain('E2E_POLICY_VERIFY_BOUND_MS');
    expect(sourceOf('e2e/support/wait.ts')).not.toContain('VERIFY_QUERY_TIMEOUT_MS');
  });

  it('gives the product command that same budget', () => {
    expect(sourceOf('packages/cli/src/commands/policy.ts')).toMatch(/budgetMs: VERIFY_BUDGET_MS/);
  });
});
