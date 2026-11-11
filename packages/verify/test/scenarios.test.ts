import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatReport, verdictOfReport } from '../src/index.ts';
import type { PropertyId, PropertyResult, VerificationReport } from '../src/index.ts';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, makeLayout, rulesOf, sshLocation, useZ3, verifyScenario } from './harness.ts';
import type { RuleSpec, VerifyOptions } from './harness.ts';

const z3 = useZ3();

const run = async (specs: readonly RuleSpec[], options: VerifyOptions & { origin?: 'user' | 'project' } = {}) => {
  const layout = makeLayout();
  const rules = rulesOf(layout, specs, options.origin);
  const report = await verifyScenario(z3.engine().api, layout, rules, options);
  return { layout, report };
};

const resultOf = (report: VerificationReport, id: PropertyId): PropertyResult => report.results.find((result) => result.id === id) as PropertyResult;

const notesOf = (result: PropertyResult) => (result.verdict.status === 'noted' ? result.verdict.ruleNotes : []);

const findingsOf = (result: PropertyResult) => (result.verdict.status === 'refuted' ? result.verdict.findings : []);

const statuses = (report: VerificationReport): Record<string, string> => Object.fromEntries(report.results.map((result) => [result.id, result.verdict.status]));

describe('a clean rule set', () => {
  it('is proved on every property, with the limits of each proof stated, and exits zero', async () => {
    const { report } = await run([
      ['allow', 'Bash(git status:*)'],
      ['deny', 'Bash(git push:*)'],
      ['deny', 'Read(./secrets/**)'],
      ['allow', 'Edit(./src/**)'],
      ['deny', 'mcp__srv__danger'],
      ['allow', 'mcp__srv'],
    ]);

    expect(statuses(report)).toEqual({ 'deny-precedence': 'proved', 'secret-reach': 'proved', 'rule-consistency': 'noted', 'bash-admission': 'proved' });
    expect(notesOf(resultOf(report, 'rule-consistency')).map((note) => [note.kind, note.modes, note.rules.map((rule) => rule.text)])).toEqual([['implied-by-mode', ['acceptEdits'], ['Edit(./src/**)']]]);
    expect(report.mismatches).toEqual([]);
    expect(report.exitCode).toBe(0);
    for (const result of report.results) {
      expect(result.proves).not.toBe('');
      expect(result.doesNotProve.length).toBeGreaterThan(0);
      const limits = result.doesNotProve.join('\n');
      expect(limits).toContain('read-only approval');
      if (result.id === 'secret-reach') {
        expect(limits).toContain('does not stop reads');
        expect(limits).not.toContain('no writable path');
      } else {
        expect(limits).toContain('no writable path except the per-spawn scratch directory');
        expect(limits).toContain('fixed git environment');
      }
    }
    const limitsOf = (id: PropertyId): string => report.results.find((result) => result.id === id)?.doesNotProve.join('\n') ?? '';
    expect(limitsOf('deny-precedence')).toContain('deny rules are decided before the mode default');
    expect(limitsOf('rule-consistency')).toContain('the sandbox never makes a rule redundant');
    expect(limitsOf('bash-admission')).toContain('open yes or no');
    expect(report.outsideProof.join('\n')).toContain('arbitrary shell command');
    const literalAllow =
      'A Bash(...) allow rule matches the command text literally, so it allows every option of its program, including options that make the program run another program, such as git -c core.pager=<program> log under Bash(git:*), find . -exec <program> {} \\; under Bash(find:*), or npm test --script-shell=<program> under Bash(npm test:*). What those options do is not checked.';
    expect(report.outsideProof).toContain(literalAllow);
    expect(formatReport(report)).toContain(`  - ${literalAllow}`);
    expect(JSON.parse(JSON.stringify(report)).outsideProof).toContain(literalAllow);
    expect(report.solver).toMatch(/^Z3 \d+\.\d+\.\d+/);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('does not call a deny rule for a wrapper or shell program dead, and lists it as outside the model', async () => {
    const { report } = await run([
      ['deny', 'Bash(sudo:*)'],
      ['deny', 'Bash(bash:*)'],
      ['deny', 'Bash(rm:*)'],
    ]);

    expect(statuses(report)).toEqual({ 'deny-precedence': 'proved', 'secret-reach': 'proved', 'rule-consistency': 'proved', 'bash-admission': 'proved' });
    expect(report.mismatches).toEqual([]);
    expect(report.exitCode).toBe(0);
    const note = report.outsideProof.find((item) => item.startsWith('Bash rules the model cannot follow')) ?? '';
    expect(note).toContain('Bash(sudo:*)');
    expect(note).toContain('Bash(bash:*)');
    expect(note).not.toContain('Bash(rm:*)');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('reports rule-consistency as unknown, never proved, for an allow rule on a wrapper program the model cannot follow', async () => {
    const { report } = await run([
      ['allow', 'Bash(sudo ls:*)'],
      ['deny', 'Bash(rm:*)'],
    ]);

    const consistency = resultOf(report, 'rule-consistency');
    expect(notesOf(consistency).map((note) => [note.kind, note.message])).toEqual([['undecided', expect.stringContaining('Bash(sudo ls:*)')]]);
    expect(report.exitCode).toBe(1);
    const note = report.outsideProof.find((item) => item.startsWith('Bash rules the model cannot follow')) ?? '';
    expect(note).toContain('Bash(sudo ls:*)');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('gives no note for an allow rule that a deny rule narrows', async () => {
    const { report } = await run([
      ['allow', 'Read(./a/**)'],
      ['deny', 'Read(./a/secret/**)'],
    ]);

    expect(resultOf(report, 'deny-precedence').verdict).toEqual({ status: 'proved', notes: [] });
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});

describe('rule sets that open what the protection forbids', () => {
  it('finds a route to a secret that an allow rule opens and names the rule', async () => {
    const { layout, report } = await run([['allow', 'Read(~/**)']]);

    const reach = resultOf(report, 'secret-reach');
    expect(reach.verdict.status).toBe('refuted');
    const finding = findingsOf(reach).find((candidate) => candidate.subject.startsWith('~/.ssh'));
    const witness = finding?.counterexample?.witness;
    expect(witness?.kind === 'path' ? witness.resolved.startsWith(path.join(layout.home, '.ssh')) : false).toBe(true);
    expect(finding?.counterexample?.cause).toContain('Read(~/**)');
    expect(finding?.counterexample?.replay).toMatchObject({ agrees: true, actual: 'allow' });
    expect(report.exitCode).toBe(1);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('finds a route through a symbolic link that the rule was compiled against, with the requested and resolved paths apart', async () => {
    const layout = makeLayout();
    fs.mkdirSync(path.join(layout.home, '.ssh'), { mode: 0o700 });
    const link = path.join(layout.root, 'homelink');
    fs.symlinkSync(layout.home, link);
    const rules = rulesOf(layout, [['allow', `Read(/${link}/**)`]]);

    const report = await verifyScenario(z3.engine().api, layout, rules);

    const reach = resultOf(report, 'secret-reach');
    expect(reach.verdict.status).toBe('refuted');
    const witness = findingsOf(reach).find((candidate) => candidate.subject.startsWith('~/.ssh'))?.counterexample?.witness;
    expect(witness?.kind === 'path' ? [witness.requested.startsWith(link), witness.resolved.startsWith(layout.home)] : []).toEqual([true, true]);
    expect(report.mismatches).toEqual([]);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('proves that no mode default reaches a secret that the workspace contains', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, []), { roots: [layout.home], secretLocations: [sshLocation(layout)] });

    const reach = resultOf(report, 'secret-reach');
    expect(reach.verdict.status).toBe('proved');
    expect(formatReport(report)).not.toContain('by the mode default');
    expect(verdictOfReport(report, 'z3 1')).toMatchObject({ verdict: 'proved', refuted: [] });
    expect(report.exitCode).toBe(0);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('proves a protected path cannot be written without approval even when an allow rule covers it', async () => {
    const { report } = await run([['allow', 'Edit(./.git/**)']]);

    expect(resultOf(report, 'secret-reach').verdict.status).toBe('proved');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('shows that bypassPermissions opens no secret by its mode default, with or without a deny rule, and that an allow rule over it refutes the rules', async () => {
    const open = await run([], { mode: 'bypassPermissions' });
    expect(resultOf(open.report, 'secret-reach').verdict.status).toBe('proved');
    expect(open.report.mismatches).toEqual([]);
    expect(verdictOfReport(open.report, 'z3 1').verdict).toBe('proved');

    const closed = await run([['deny', 'Read(~/.ssh/**)']], { mode: 'bypassPermissions' });
    expect(resultOf(closed.report, 'secret-reach').verdict.status).toBe('proved');

    const opened = await run([['allow', 'Read(~/**)']], { mode: 'bypassPermissions' });
    expect(resultOf(opened.report, 'secret-reach').verdict.status).toBe('refuted');
    expect(findingsOf(resultOf(opened.report, 'secret-reach'))[0]?.counterexample?.cause).toContain('Read(~/**)');
    expect(verdictOfReport(opened.report, 'z3 1').verdict).toBe('refuted');
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);
});

describe('rules naming the background job tools', () => {
  it('are accepted and leave every property proved', async () => {
    const { report } = await run([
      ['deny', 'KillBash'],
      ['deny', 'BashOutput'],
    ]);

    expect(Object.values(statuses(report)).every((status) => status === 'proved')).toBe(true);
  }, 120_000);
});

describe('rules that cannot take effect', () => {
  const kindsOf = (report: VerificationReport) => notesOf(resultOf(report, 'rule-consistency')).map((note) => [note.kind, note.rules.map((rule) => rule.text)]);

  it('notes an allow rule that lies entirely inside a deny rule, naming both', async () => {
    const { report } = await run([
      ['deny', 'Read(./a/**)'],
      ['allow', 'Read(./a/b/**)'],
    ]);

    expect(kindsOf(report)).toEqual([['no-effect', ['Read(./a/b/**)', 'Read(./a/**)']]]);
    expect(notesOf(resultOf(report, 'rule-consistency'))[0]?.message).toContain('deny is decided before allow');
    expect(report.exitCode).toBe(0);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('notes a rule written twice once', async () => {
    const { report } = await run([
      ['deny', 'Edit(./src/**)'],
      ['deny', 'Edit(./src/**)'],
    ]);

    expect(kindsOf(report)).toEqual([['duplicate', ['Edit(./src/**)', 'Edit(./src/**)']]]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('notes an ask rule that a deny rule fully covers', async () => {
    const { report } = await run([
      ['deny', 'mcp__srv'],
      ['ask', 'mcp__srv__tool'],
    ]);

    expect(kindsOf(report)).toEqual([['no-effect', ['mcp__srv__tool', 'mcp__srv']]]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});

describe('solver limits', () => {
  it('reports unknown, never proved, for a query the solver cannot finish within the verification budget', async () => {
    const { report } = await run(
      [
        ['allow', 'Bash(git:*)'],
        ['deny', 'Bash(git push:*)'],
        ['deny', 'Bash(rm:*)'],
        ['allow', 'Bash(ls:*)'],
      ],
      { budgetMs: 1 },
    );

    const unknown = report.results.filter((result) => result.verdict.status === 'unknown');
    expect(unknown.length).toBeGreaterThan(0);
    for (const result of unknown) expect(result.verdict.status === 'unknown' ? result.verdict.reason : '').not.toBe('');
    expect(report.exitCode).toBe(1);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);
});

describe('the decision code failing on a modelled input', () => {
  it('does not crash on a bare Bash allow rule: the model and the decision code agree on every command', async () => {
    const { report } = await run([['allow', 'Bash']]);

    expect(report.mismatches).toEqual([]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});
