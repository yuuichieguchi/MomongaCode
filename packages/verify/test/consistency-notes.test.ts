import { PERMISSION_MODES } from '@momonga/protocol';
import type { RuleNote } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { formatReport, verdictOfReport } from '../src/index.ts';
import type { VerificationReport } from '../src/index.ts';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, makeLayout, rulesOf, useZ3, verifyScenario } from './harness.ts';
import type { Layout, RuleSpec, VerifyOptions } from './harness.ts';

const z3 = useZ3();

const consistencyOf = (report: VerificationReport) => report.results.find((result) => result.id === 'rule-consistency');

const notesOf = (report: VerificationReport): readonly RuleNote[] => {
  const verdict = consistencyOf(report)?.verdict;
  return verdict?.status === 'noted' ? verdict.ruleNotes : [];
};

const run = async (specs: readonly RuleSpec[], options: VerifyOptions = {}, layout: Layout = makeLayout()): Promise<VerificationReport> =>
  verifyScenario(z3.engine().api, layout, rulesOf(layout, specs), options);

describe('rule consistency gives notes and never a refutation', () => {
  it('notes two deny rules that cover each other, in every mode, and refutes nothing', async () => {
    const layout = makeLayout();
    const lists: RuleNote[][] = [];
    for (const mode of PERMISSION_MODES) {
      const report = await run([['deny', 'Write'], ['deny', 'Edit']], { mode }, layout);
      expect(consistencyOf(report)?.verdict.status).toBe('noted');
      expect(report.exitCode).toBe(0);
      expect(verdictOfReport(report, 'z3 1')).toMatchObject({ verdict: 'proved', refuted: [] });
      lists.push([...notesOf(report)]);
    }
    const [first] = lists;
    expect(first?.map((note) => [note.kind, note.rules.map((rule) => rule.text)])).toEqual([
      ['no-effect', ['Write', 'Edit']],
      ['no-effect', ['Edit', 'Write']],
    ]);
    for (const list of lists) expect(list).toEqual(first);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('notes a rule written in two layers once, naming both layers', async () => {
    const layout = makeLayout();
    const rules = [...rulesOf(layout, [['deny', 'Read(./secrets/**)']], 'user'), ...rulesOf(layout, [['deny', 'Read(./secrets/**)']], 'project')];
    const report = await verifyScenario(z3.engine().api, layout, rules);

    expect(notesOf(report)).toEqual([
      expect.objectContaining({
        kind: 'duplicate',
        rules: [
          { text: 'Read(./secrets/**)', origin: 'user', source: 'user-settings' },
          { text: 'Read(./secrets/**)', origin: 'project', source: 'project-settings' },
        ],
      }),
    ]);
    expect(verdictOfReport(report, 'z3 1').verdict).toBe('proved');
    expect(formatReport(report)).toContain('[NOTES  ] ');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('notes a read allow rule that the modes already grant, with the same note in every mode', async () => {
    const layout = makeLayout();
    const lists: RuleNote[][] = [];
    for (const mode of PERMISSION_MODES) {
      const report = await run([['allow', 'Read(./src/**)']], { mode }, layout);
      expect(verdictOfReport(report, 'z3 1').refuted).toEqual([]);
      lists.push([...notesOf(report)]);
    }
    expect(lists[0]).toEqual([expect.objectContaining({ kind: 'implied-by-mode', modes: ['manual', 'acceptEdits', 'plan', 'auto'], rules: [expect.objectContaining({ text: 'Read(./src/**)' })] })]);
    for (const list of lists) expect(list).toEqual(lists[0]);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('names only the mode that implies an edit allow rule, whatever mode is verified', async () => {
    const layout = makeLayout();
    const manual = notesOf(await run([['allow', 'Edit(./src/**)']], { mode: 'manual' }, layout));
    const plan = notesOf(await run([['allow', 'Edit(./src/**)']], { mode: 'plan' }, layout));

    expect(manual).toEqual([expect.objectContaining({ kind: 'implied-by-mode', modes: ['acceptEdits'] })]);
    expect(plan).toEqual(manual);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('gives no note for an allow rule narrowed by a deny rule', async () => {
    const report = await run([['allow', 'Bash(git:*)'], ['deny', 'Bash(git push:*)']]);

    expect(consistencyOf(report)?.verdict).toEqual({ status: 'proved', notes: [] });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('still refutes a written allow rule that opens a secret location', async () => {
    const report = await run([['allow', 'Read(~/**)']]);
    const verdict = verdictOfReport(report, 'z3 1');

    expect(verdict.verdict).toBe('refuted');
    expect(verdict.refuted.map((refutation) => refutation.property)).toContain('secret-reach');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});

describe('a mandate allow list with Edit(*) and Write(*)', () => {
  it('notes Write(*) as covered by Edit(*) and refutes nothing', async () => {
    const report = await run([['allow', 'Edit(*)'], ['allow', 'Write(*)']]);

    expect(verdictOfReport(report, 'z3 1').refuted).toEqual([]);
    expect(notesOf(report)).toContainEqual(expect.objectContaining({ kind: 'no-effect', rules: [expect.objectContaining({ text: 'Write(*)' }), expect.objectContaining({ text: 'Edit(*)' })] }));
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);
});
