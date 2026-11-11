import { describe, expect, it } from 'vitest';
import { formatReport, verdictOfReport } from '../src/index.ts';
import type { PropertyId, PropertyResult, VerificationReport } from '../src/index.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, makeLayout, rulesOf, useZ3, verifyScenario } from './harness.ts';
import type { RuleSpec } from './harness.ts';

const z3 = useZ3();

const run = async (specs: readonly RuleSpec[]): Promise<VerificationReport> => {
  const layout = makeLayout();
  return verifyScenario(z3.engine().api, layout, rulesOf(layout, specs));
};

const resultOf = (report: VerificationReport, id: PropertyId): PropertyResult => report.results.find((result) => result.id === id) as PropertyResult;

describe('an allow rule on a program with a deny rule on one of its subcommands', () => {
  it('is proved with no note and no refutation when the program has an option table', async () => {
    const report = await run([
      ['allow', 'Bash(git:*)'],
      ['deny', 'Bash(git push:*)'],
    ]);

    expect(report.results.map((result) => [result.id, result.verdict])).toEqual([
      ['deny-precedence', { status: 'proved', notes: [] }],
      ['secret-reach', { status: 'proved', notes: [] }],
      ['rule-consistency', { status: 'proved', notes: [] }],
      ['bash-admission', { status: 'proved', notes: [] }],
    ]);
    expect(report.mismatches).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(verdictOfReport(report, 'z3 1')).toMatchObject({ verdict: 'proved', refuted: [], unknown: [] });
    expect(formatReport(report)).not.toContain('  note: ');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('is proved with a note that names the rule when the program has no option table', async () => {
    const report = await run([
      ['allow', 'Bash(frobnicate:*)'],
      ['deny', 'Bash(frobnicate push:*)'],
    ]);

    const admission = resultOf(report, 'bash-admission');
    expect(admission.verdict.status).toBe('proved');
    expect(admission.verdict.notes).toEqual([expect.stringMatching(/^Bash\(frobnicate push:\*\) .* is compared by adjacent words only, because its program has no option table/)]);
    expect(report.mismatches).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(verdictOfReport(report, 'z3 1').refuted).toEqual([]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
