import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { hostFilesystemOf, NEVER_CANCELLED, testSecretLocations } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { checkRuleConsistency } from '../src/properties.ts';
import type { SolveResult } from '../src/smt.ts';
import { buildQueryContext } from '../src/verify.ts';
import { caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';

const z3 = useZ3();

describe('rule-consistency when the last probe of a rule cannot be decided', () => {
  it('notes the rule as not decided, never as matching no input, when only the reach probe is undecided', async () => {
    const layout = makeLayout();
    const roots = [layout.project];
    const fileSystem = caseSensitiveFs();
    const context = await buildQueryContext(z3.engine().api, { unixSockets: { kind: 'limited', allowed: [] }, deniedLocations: testSecretLocations(layout.home), signal: NEVER_CANCELLED,
      rules: rulesOf(layout, [['allow', 'Read(./a/**)']]),
      roots,
      mode: 'manual',
      home: layout.home,
      cwd: layout.project,
      protectedSet: await protectedSetFor(roots, fileSystem),
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
    expect(baseline.verdict.status === 'noted' ? baseline.verdict.ruleNotes.map((note) => note.kind) : []).toEqual(['never-matches']);

    const lastCall = calls;
    let seen = 0;
    context.models.smt.solve = async (): Promise<SolveResult> => {
      seen += 1;
      return seen === lastCall ? { status: 'unknown', reason: 'budget spent at reach' } : { status: 'unsat' };
    };
    const result = await checkRuleConsistency(context);

    expect(result.verdict.status === 'noted' ? result.verdict.ruleNotes.map((note) => [note.kind, note.message]) : []).toEqual([['undecided', expect.stringContaining('budget spent at reach')]]);
  });
});
