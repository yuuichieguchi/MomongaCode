import fs from 'node:fs';
import path from 'node:path';
import { HOST_RULE_ENFORCEMENT, protectedSetFor } from '@momonga/foundation';
import { hostFilesystemOf } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { PropertyId, PropertyResult, VerificationReport } from '../src/index.ts';
import { checkBashAdmission, checkDenyPrecedence, checkRuleConsistency, checkSecretReach } from '../src/properties.ts';
import type { SecretLocation } from '../src/properties.ts';
import type { QueryContext } from '../src/queries.ts';
import type { SolveResult } from '../src/smt.ts';
import { buildQueryContext } from '../src/verify.ts';
import {
  SOLVER_EXHAUSTIVE_SWEEP_TEST_TIMEOUT_MS,
  SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS,
  SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  caseSensitiveFs,
  makeLayout,
  rulesOf,
  sshLocation,
  useZ3,
  verifyScenario,
} from './harness.ts';
import type { Layout, RuleSpec } from './harness.ts';

const z3 = useZ3();

const resultOf = (report: VerificationReport, id: PropertyId): PropertyResult => report.results.find((result) => result.id === id) as PropertyResult;

describe('round 2, finding 8: secret locations are compared by their real location', () => {
  const linkedSsh = (): Layout => {
    const layout = makeLayout();
    fs.mkdirSync(path.join(layout.home, 'dotfiles', 'ssh'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(layout.home, 'dotfiles', 'ssh'), path.join(layout.home, '.ssh'));
    return layout;
  };

  it('refutes secret-reach when ~/.ssh is a link into a folder that an allow rule covers', async () => {
    const layout = linkedSsh();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Read(~/dotfiles/**)']]));

    const reach = resultOf(report, 'secret-reach');
    expect(reach.verdict.status).toBe('refuted');
    const finding = reach.verdict.status === 'refuted' ? reach.verdict.findings.find((candidate) => candidate.subject.startsWith('~/.ssh')) : undefined;
    const witness = finding?.counterexample?.witness;
    expect(witness?.kind === 'path' ? witness.resolved.startsWith(path.join(layout.home, 'dotfiles', 'ssh')) : false).toBe(true);
    expect(finding?.counterexample?.replay).toMatchObject({ agrees: true, actual: 'allow' });
    expect(report.exitCode).toBe(1);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('does not report a route through the link path itself, which no real access can resolve to', async () => {
    const layout = linkedSsh();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Read(~/.ssh/**)']]));

    expect(resultOf(report, 'secret-reach').verdict.status).toBe('refuted');
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('reports unknown, never proved, when a secret location cannot be resolved', async () => {
    const layout = makeLayout();
    fs.symlinkSync(path.join(layout.home, 'loop'), path.join(layout.home, 'loop'));
    const location: SecretLocation = { label: '~/loop', directory: path.join(layout.home, 'loop', 'keys'), accesses: ['read'] };
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, []), { secretLocations: [sshLocation(layout), location] });

    const reach = resultOf(report, 'secret-reach');
    expect(reach.verdict.status).toBe('unknown');
    expect(reach.verdict.status === 'unknown' ? reach.verdict.reason : '').toContain('~/loop');
    expect(report.exitCode).toBe(1);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});

describe('round 2, finding 14: a word with = is inside the command alphabet', () => {
  it('judges a Bash rule with an assignment-style word instead of listing it as outside the model', async () => {
    const layout = makeLayout();
    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', 'Bash(make CC=gcc:*)']]));

    expect(report.outsideProof.join('\n')).not.toContain('make CC=gcc');
    expect(resultOf(report, 'rule-consistency').verdict.status).toBe('proved');
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);
});

const forceUnknownAt =(context: QueryContext, site: number): { calls: () => number } => {
  const original = context.models.smt.solve.bind(context.models.smt);
  let calls = 0;
  context.models.smt.solve = async (constraints, timeoutMs): Promise<SolveResult> => {
    const index = calls;
    calls += 1;
    return index === site ? { status: 'unknown', reason: `forced timeout at query ${site}` } : original(constraints, timeoutMs);
  };
  return { calls: () => calls };
};

type Property = {
  id: PropertyId;
  rules: readonly RuleSpec[];
  check: (context: QueryContext, locations: readonly SecretLocation[]) => Promise<PropertyResult>;
};

const PROPERTIES: readonly Property[] = [
  {
    id: 'deny-precedence',
    rules: [['allow', 'Read(./a/**)'], ['deny', 'Read(./a/secret/**)']],
    check: (context) => checkDenyPrecedence(context),
  },
  {
    id: 'secret-reach',
    rules: [['deny', 'Read(~/.ssh/**)'], ['deny', 'Edit(~/.ssh/**)']],
    check: checkSecretReach,
  },
  {
    id: 'rule-consistency',
    rules: [['allow', 'Edit(./a/**)'], ['deny', 'Edit(./a/secret/**)']],
    check: (context) => checkRuleConsistency(context),
  },
  {
    id: 'bash-admission',
    rules: [['allow', 'Bash(git status:*)'], ['deny', 'Bash(git push:*)']],
    check: (context) => checkBashAdmission(context),
  },
];

describe('round 2, finding 9: a query the solver cannot decide never leaves a property proved', () => {
  it.each(PROPERTIES)('$id: a forced timeout at every query site, one site at a time', async ({ id, rules, check }) => {
    const layout = makeLayout();
    const roots = [layout.project];
    const fileSystem = caseSensitiveFs();
    const contextFor = (): QueryContext =>
      buildQueryContext(z3.engine().api, {
        rules: rulesOf(layout, rules),
        roots,
        mode: 'default',
        home: layout.home,
        cwd: layout.project,
        protectedSet: protectedSetFor(roots, fileSystem),
        fs: hostFilesystemOf(fileSystem),
        secretLocations: [sshLocation(layout)],
        exemptDirectory: null,
        enforcement: HOST_RULE_ENFORCEMENT,
        budgetMs: 120_000,
      });

    const baselineContext = contextFor();
    const counter = forceUnknownAt(baselineContext, -1);
    const baseline = await check(baselineContext, [sshLocation(layout)]);
    expect(baseline.id).toBe(id);
    expect(baseline.verdict.status).toBe('proved');
    const sites = counter.calls();
    expect(sites).toBeGreaterThan(0);

    const statuses: string[] = [];
    for (let site = 0; site < sites; site += 1) {
      const context = contextFor();
      forceUnknownAt(context, site);
      const result = await check(context, [sshLocation(layout)]);
      statuses.push(result.verdict.status);
    }
    expect(statuses).toEqual(Array.from({ length: sites }, () => 'unknown'));
  }, SOLVER_EXHAUSTIVE_SWEEP_TEST_TIMEOUT_MS);
});
