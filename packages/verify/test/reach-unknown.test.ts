import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { hostFilesystemOf } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { checkRuleConsistency } from '../src/properties.ts';
import type { SolveResult } from '../src/smt.ts';
import { buildQueryContext } from '../src/verify.ts';
import { caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';

const z3 = useZ3();

describe('rule-consistency when the last probe of a rule cannot be decided', () => {
  it('reports unknown, never "matches no input", when only the reach probe is undecided', async () => {
    const layout = makeLayout();
    const roots = [layout.project];
    const fileSystem = caseSensitiveFs();
    const context = buildQueryContext(z3.engine().api, {
      rules: rulesOf(layout, [['allow', 'Read(./a/**)']]),
      roots,
      mode: 'default',
      home: layout.home,
      cwd: layout.project,
      protectedSet: protectedSetFor(roots, fileSystem),
      fs: hostFilesystemOf(fileSystem),
      secretLocations: [sshLocation(layout)],
      exemptDirectory: null,
      enforcement: ruleEnforcementOf('none'),
      budgetMs: 120_000,
    });
    let calls = 0;
    context.models.smt.solve = async (): Promise<SolveResult> => {
      calls += 1;
      return { status: 'unsat' };
    };
    const baseline = await checkRuleConsistency(context);
    expect(baseline.verdict.status).toBe('refuted');

    const lastCall = calls;
    let seen = 0;
    context.models.smt.solve = async (): Promise<SolveResult> => {
      seen += 1;
      return seen === lastCall ? { status: 'unknown', reason: 'budget spent at reach' } : { status: 'unsat' };
    };
    const result = await checkRuleConsistency(context);

    expect(result.verdict.status).toBe('unknown');
  });
});
