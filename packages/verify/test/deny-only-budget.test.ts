import { describe, expect, it } from 'vitest';
import { protectedSetFor, ruleEnforcementOf, systemTiming } from '@momonga/foundation';
import { hostFilesystemOf, NEVER_CANCELLED, testSecretLocations } from '@momonga/testkit';
import { verifyPermissions } from '../src/index.ts';
import { caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';

const z3 = useZ3();

const BUDGET_MS = 200;
const LOAD_ALLOWANCE_MS = 5000;

describe('the solve budget of a deny-only rule set', () => {
  it('returns within its budget and its load allowance, and leaves the other properties their verdicts', async () => {
    const layout = makeLayout();
    const fileSystem = caseSensitiveFs();
    const roots = [layout.project];
    const started = systemTiming.monotonicMs();
    const report = await verifyPermissions(z3.engine().api, { unixSockets: { kind: 'limited', allowed: [] }, deniedLocations: testSecretLocations(layout.home),
      rules: rulesOf(layout, [['deny', 'Write(src/secret/**)'], ['deny', 'Read(.env)']]),
      roots, mode: 'manual', home: layout.home, cwd: layout.project,
      protectedSet: await protectedSetFor(roots, fileSystem), fs: hostFilesystemOf(fileSystem), signal: NEVER_CANCELLED,
      secretLocations: [sshLocation(layout)], exemptDirectory: null, enforcement: ruleEnforcementOf('none'), budgetMs: BUDGET_MS });
    const elapsed = systemTiming.monotonicMs() - started;

    expect(elapsed).toBeLessThan(BUDGET_MS + LOAD_ALLOWANCE_MS);
    expect(report.results.find((result) => result.id === 'deny-precedence')?.verdict.status).toBe('proved');
  });
});
