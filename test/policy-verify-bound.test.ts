import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import * as bounds from '../e2e/support/wait.ts';
import { STARTUP_TIMEOUT_MS } from '@momonga/foundation';
import { readyBoundOfStallMs } from '../packages/cli/src/daemon/ensure-daemon.ts';

type DerivedBounds = { policyVerifyBoundMs?: () => Promise<number>; E2E_SOLVER_LOAD_ALLOWANCE_MS?: number };

const sourceOf = (relative: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');

describe('the e2e bound of policy verify', () => {
  it('is the daemon ready bound, the solver load allowance and the overall verification budget', async () => {
    const { policyVerifyBoundMs, E2E_SOLVER_LOAD_ALLOWANCE_MS } = bounds as DerivedBounds;

    expect(E2E_SOLVER_LOAD_ALLOWANCE_MS).toBeGreaterThan(0);
    expect(await policyVerifyBoundMs?.()).toBe((await readyBoundOfStallMs(STARTUP_TIMEOUT_MS)) + (E2E_SOLVER_LOAD_ALLOWANCE_MS as number) + RULE_VERIFY_BUDGET_MS);
  });

  it('no longer multiplies a query timeout by a hand-restated property count', () => {
    expect(Object.keys(bounds)).not.toContain('E2E_POLICY_VERIFY_PROPERTY_COUNT');
    expect(Object.keys(bounds)).not.toContain('E2E_POLICY_VERIFY_BOUND_MS');
    expect(sourceOf('e2e/support/wait.ts')).not.toContain('VERIFY_QUERY_TIMEOUT_MS');
  });

  it('leaves the verification to the daemon: the product command runs no solver of its own', () => {
    const command = sourceOf('packages/cli/src/commands/policy.ts');
    expect(command).not.toMatch(/verifyPermissions|openSolver|budgetMs/);
    expect(sourceOf('packages/runtime/src/process/start-runtime-process.ts')).toMatch(/budgetMs: RULE_VERIFY_BUDGET_MS/);
  });
});
