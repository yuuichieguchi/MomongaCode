import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatReport } from '../src/index.ts';
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

    expect(statuses(report)).toEqual({ 'deny-precedence': 'proved', 'secret-reach': 'proved', 'rule-consistency': 'proved', 'bash-admission': 'proved' });
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
    expect(consistency.verdict.status).toBe('unknown');
    expect(consistency.verdict.status === 'unknown' ? consistency.verdict.reason : '').toContain('Bash(sudo ls:*)');
    expect(report.exitCode).toBe(1);
    const note = report.outsideProof.find((item) => item.startsWith('Bash rules the model cannot follow')) ?? '';
    expect(note).toContain('Bash(sudo ls:*)');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('records where an allow rule overlaps a deny rule and which side wins there', async () => {
    const { report } = await run([
      ['allow', 'Read(./a/**)'],
      ['deny', 'Read(./a/secret/**)'],
    ]);

    const precedence = resultOf(report, 'deny-precedence');
    expect(precedence.verdict.status).toBe('proved');
    expect(precedence.verdict.notes.join('\n')).toContain('the outcome there is deny');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});

describe('rule sets with a known escape', () => {
  it('finds the subcommand that a Bash allow prefix admits around a deny, and the decision code agrees it is allowed', async () => {
    const { report } = await run([
      ['allow', 'Bash(git:*)'],
      ['deny', 'Bash(git push:*)'],
    ]);

    const admission = resultOf(report, 'bash-admission');
    expect(admission.verdict.status).toBe('refuted');
    const finding = findingsOf(admission)[0];
    expect(finding?.counterexample?.witness).toMatchObject({ kind: 'command' });
    const command = finding?.counterexample?.witness.kind === 'command' ? finding.counterexample.witness.command : '';
    expect(command).toMatch(/^git( +-\S*)+ +push/);
    expect(finding?.counterexample?.predicted).toBe('allow');
    expect(finding?.counterexample?.replay).toMatchObject({ agrees: true, actual: 'allow' });
    expect(report.exitCode).toBe(1);
    expect(report.mismatches).toEqual([]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

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

  it('reports that the mode default, not a rule, reaches a secret when the workspace contains it', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, []), { roots: [layout.home], secretLocations: [sshLocation(layout)] });

    const reach = resultOf(report, 'secret-reach');
    expect(reach.verdict.status).toBe('refuted');
    expect(findingsOf(reach)[0]?.counterexample?.cause).toContain('mode default');
    expect(report.exitCode).toBe(1);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('proves a protected path cannot be written without approval even when an allow rule covers it', async () => {
    const { report } = await run([['allow', 'Edit(./.git/**)']]);

    expect(resultOf(report, 'secret-reach').verdict.status).toBe('proved');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('shows that bypassPermissions leaves a secret open until a deny rule closes it', async () => {
    const open = await run([], { mode: 'bypassPermissions' });
    expect(resultOf(open.report, 'secret-reach').verdict.status).toBe('refuted');

    const closed = await run([['deny', 'Read(~/.ssh/**)']], { mode: 'bypassPermissions' });
    expect(resultOf(closed.report, 'secret-reach').verdict.status).toBe('proved');
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

describe('rules that cannot take effect or that contradict', () => {
  it('flags an allow rule that lies entirely inside a deny rule', async () => {
    const { report } = await run([
      ['deny', 'Read(./a/**)'],
      ['allow', 'Read(./a/b/**)'],
    ]);

    const consistency = resultOf(report, 'rule-consistency');
    expect(consistency.verdict.status).toBe('refuted');
    const messages = findingsOf(consistency).map((finding) => `${finding.subject}: ${finding.message}`);
    expect(messages.some((message) => message.includes('Read(./a/b/**)') && message.includes('contradicts the deny rule'))).toBe(true);
    expect(messages.some((message) => message.startsWith('Read(./a/b/**)') && message.includes('can never take effect'))).toBe(true);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('flags a duplicated allow rule, whose removal changes nothing', async () => {
    const { report } = await run([
      ['allow', 'Edit(./src/**)'],
      ['allow', 'Edit(./src/**)'],
    ]);

    expect(findingsOf(resultOf(report, 'rule-consistency'))).toHaveLength(2);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('flags an allow edit rule that plan mode never lets take effect, and not in default mode', async () => {
    const plan = await run([['allow', 'Edit(./src/**)']], { mode: 'plan' });
    expect(resultOf(plan.report, 'rule-consistency').verdict.status).toBe('refuted');

    const normal = await run([['allow', 'Edit(./src/**)']]);
    expect(resultOf(normal.report, 'rule-consistency').verdict.status).toBe('proved');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('flags a read allow rule that the workspace default already grants', async () => {
    const { report } = await run([['allow', 'Read(./src/**)']]);

    const finding = findingsOf(resultOf(report, 'rule-consistency'))[0];
    expect(finding?.message).toContain('mode default');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('treats an ask rule that a deny rule fully covers as one that cannot take effect', async () => {
    const { report } = await run([
      ['deny', 'mcp__srv'],
      ['ask', 'mcp__srv__tool'],
    ]);

    expect(findingsOf(resultOf(report, 'rule-consistency')).map((finding) => finding.subject)).toEqual([expect.stringContaining('mcp__srv__tool')]);
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
