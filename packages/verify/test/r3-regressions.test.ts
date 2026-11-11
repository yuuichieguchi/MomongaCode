import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { computeFileRules, decide } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import { describe, expect, it } from 'vitest';
import type { PropertyId, VerificationReport } from '../src/index.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, caseSensitiveFs, makeLayout, rulesOf, useZ3, verifyScenario } from './harness.ts';
import type { Layout } from './harness.ts';
import { testProbes, testSecretLocations } from '@momonga/testkit';

const z3 = useZ3();

const statusOf = (report: VerificationReport, id: PropertyId): string | undefined => report.results.find((result) => result.id === id)?.verdict.status;

const decideCommand = async (layout: Layout, rules: readonly PermissionRule[], command: string): Promise<string> => {
  const roots = [layout.project];
  const fileSystem = caseSensitiveFs();
  return (await decide({ secretLocations: testSecretLocations(layout.home),
    tool: { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' },
    subject: { kind: 'command', tool: 'Bash', command },
    mode: 'manual',
    rules: [...rules],
    roots,
    home: layout.home,
    cwd: layout.project,
    fileRules: await computeFileRules([...rules], roots, null, ruleEnforcementOf('none'), testProbes()),
    protectedSet: await protectedSetFor(roots, fileSystem),
    fs: fileSystem,
    searchPath: '/usr/bin:/bin',
    isWritable: () => false,
  })).kind;
};

describe('finding 6: an unmodelled deny or ask rule never leaves a proof standing', () => {
  it.each(['deny', 'ask'] as const)('allow git with an unmodelled %s rule is unknown, because decide can pass around that rule', async (effect) => {
    const layout = makeLayout();
    const rules = rulesOf(layout, [['allow', 'Bash(git:*)'], [effect, 'Bash(git push origin~1:*)']]);
    const report = await verifyScenario(z3.engine().api, layout, rules);

    expect(await decideCommand(layout, rules, 'git -C . push origin~1 x')).toBe(effect);
    expect(statusOf(report, 'bash-admission')).toBe('unknown');
    expect(statusOf(report, 'rule-consistency')).toBe('noted');
    expect(report.exitCode).toBe(1);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('a dead unmodelled deny rule is not reported as proved consistent', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['deny', 'Bash(git push origin~1:*)'], ['deny', 'Bash(git:*)']]));

    expect(statusOf(report, 'rule-consistency')).toBe('noted');
    expect(report.exitCode).toBe(0);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('the outside-proof note no longer claims no proved result depends on the rule', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Bash(git:*)'], ['deny', 'Bash(git push origin~1:*)']]));

    expect(report.outsideProof.join('\n')).toContain('git push origin~1');
    expect(report.outsideProof.join('\n')).not.toContain('no proved result depends on it');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('an unmodelled allow rule against a modelled deny rule makes bash-admission unknown and names the rule', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Bash(sudo ls:*)'], ['deny', 'Bash(git push origin:*)']]));
    const result = report.results.find((item) => item.id === 'bash-admission');

    expect(result?.verdict.status).toBe('unknown');
    expect(result?.verdict.status === 'unknown' ? result.verdict.reason : '').toContain('Bash(sudo ls:*)');
    expect(report.exitCode).toBe(1);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it.each(['Bash(sudo:*)', 'Bash(bash:*)', 'Bash(env:*)', 'Bash(sudo rm:*)', 'Bash(eval:*)'])('deny %s is modelled: rule-consistency is proved against decide, without mismatches', async (text) => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['deny', text]]));

    expect(statusOf(report, 'rule-consistency')).toBe('proved');
    expect(report.mismatches).toEqual([]);
    expect(report.exitCode).toBe(0);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('a duplicated wrapper deny rule is not proved: no input shows either one changing a decision', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['deny', 'Bash(sudo:*)'], ['deny', 'Bash(sudo:*)']]));

    expect(statusOf(report, 'rule-consistency')).toBe('noted');
    expect(report.exitCode).toBe(0);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('a wrapper deny rule of several words leaves bash-admission unknown while an allow rule exists', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Bash(git:*)'], ['deny', 'Bash(sudo rm:*)']]));
    const result = report.results.find((item) => item.id === 'bash-admission');

    expect(result?.verdict.status).toBe('unknown');
    expect(result?.verdict.status === 'unknown' ? result.verdict.reason : '').toContain('Bash(sudo rm:*)');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('a wrapper deny rule of one word does not disturb bash-admission', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Bash(git:*)'], ['deny', 'Bash(sudo:*)']]));

    expect(statusOf(report, 'bash-admission')).toBe('proved');
    expect(report.exitCode).toBe(0);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('a wrapper ask rule is noted as not decided and is named', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['ask', 'Bash(sudo:*)']]));
    const result = report.results.find((item) => item.id === 'rule-consistency');

    expect(result?.verdict.status).toBe('noted');
    expect(result?.verdict.status === 'noted' ? result.verdict.ruleNotes.map((note) => [note.kind, note.message]) : []).toEqual([['undecided', expect.stringContaining('Bash(sudo:*)')]]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('a tool-wide allow Bash does not admit a denied subcommand with options before it', async () => {
    const layout = makeLayout();
    const rules = rulesOf(layout, [['allow', 'Bash'], ['deny', 'Bash(git push:*)']]);
    const report = await verifyScenario(z3.engine().api, layout, rules);

    expect(await decideCommand(layout, rules, 'git -C . push x')).toBe('deny');
    expect(await decideCommand(layout, rules, 'git push x')).toBe('deny');
    expect(statusOf(report, 'bash-admission')).toBe('proved');
    expect(report.exitCode).toBe(0);
    expect(report.mismatches).toEqual([]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('the subject line counts a tool-wide allow rule', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Bash'], ['deny', 'Bash(git push:*)']]));
    const result = report.results.find((item) => item.id === 'bash-admission');

    expect(result?.subject).toContain('1 Bash allow rule(s)');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('a deny rule of three words is proved against an allow rule on the program', async () => {
    const layout = makeLayout();
    const rules = rulesOf(layout, [['allow', 'Bash(git:*)'], ['deny', 'Bash(git push origin:*)']]);
    const report = await verifyScenario(z3.engine().api, layout, rules);

    expect(await decideCommand(layout, rules, 'git --no-pager push -q origin main')).toBe('deny');
    expect(statusOf(report, 'bash-admission')).toBe('proved');
    expect(report.mismatches).toEqual([]);
    expect(report.exitCode).toBe(0);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
