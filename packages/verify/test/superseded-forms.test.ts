import { describe, expect, it } from 'vitest';
import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { hostFilesystemOf, NEVER_CANCELLED } from '@momonga/testkit';
import { verifyPermissions } from '../src/index.ts';
import type { PropertyResult, VerificationReport, VerifyRequest } from '../src/index.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';
import type { RuleSpec } from './harness.ts';

const z3 = useZ3();

const SUPERSEDED = [
  { operation: 'GitPush', argv: ['git', 'push'] },
  { operation: 'PullRequestCreate', argv: ['gh', 'pr', 'create'] },
  { operation: 'PullRequestMerge', argv: ['gh', 'pr', 'merge'] },
];

const verifyWith = async (specs: readonly RuleSpec[]): Promise<VerificationReport> => {
  const layout = makeLayout();
  const fileSystem = caseSensitiveFs();
  const roots = [layout.project];
  const request = {
    rules: rulesOf(layout, specs),
    roots,
    mode: 'manual',
    home: layout.home,
    cwd: layout.project,
    protectedSet: await protectedSetFor(roots, fileSystem),
    fs: hostFilesystemOf(fileSystem), signal: NEVER_CANCELLED,
    secretLocations: [sshLocation(layout)],
    exemptDirectory: null,
    enforcement: ruleEnforcementOf('none'),
    budgetMs: 120_000,
    supersededForms: SUPERSEDED,
    alwaysOperations: ['PullRequestMerge'],
  } as VerifyRequest;
  return verifyPermissions(z3.engine().api, request);
};

const supersededResult = (report: VerificationReport): PropertyResult | undefined => report.results.find((result) => (result.id as string) === 'superseded-forms');

describe('the superseded-forms property (G9)', () => {
  it(
    'reports an allow rule that admits git push as duplicate prevention not guaranteed, naming the operation',
    async () => {
      const report = await verifyWith([['allow', 'Bash(git:*)']]);
      const result = supersededResult(report);
      expect(result?.verdict.status).toBe('refuted');
      const findings = result?.verdict.status === 'refuted' ? result.verdict.findings : [];
      expect(findings.some((finding) => finding.message.includes('duplicate prevention not guaranteed') && finding.message.includes('GitPush'))).toBe(true);
      expect(report.exitCode).toBe(1);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'reports an allow rule for gh that admits gh pr merge',
    async () => {
      const result = supersededResult(await verifyWith([['allow', 'Bash(gh:*)']]));
      const findings = result?.verdict.status === 'refuted' ? result.verdict.findings : [];
      expect(findings.some((finding) => finding.message.includes('PullRequestMerge'))).toBe(true);
      expect(findings.some((finding) => finding.message.includes('PullRequestCreate'))).toBe(true);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'proves the property for rules that admit no superseded form',
    async () => {
      const result = supersededResult(await verifyWith([['allow', 'Bash(npm:*)'], ['allow', 'Bash(ls:*)']]));
      expect(result?.verdict.status).toBe('proved');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});

describe('the mandate-holds property (OD-6)', () => {
  const holdsResult = (report: VerificationReport): PropertyResult | undefined => report.results.find((result) => (result.id as string) === 'mandate-holds');

  it(
    'reports an allow rule written for an operation that always needs a person, and says the call is held',
    async () => {
      const result = holdsResult(await verifyWith([['allow', 'PullRequestMerge'], ['allow', 'PullRequestCreate']]));
      expect(result?.verdict.status).toBe('refuted');
      const findings = result?.verdict.status === 'refuted' ? result.verdict.findings : [];
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toBe('this allow rule names PullRequestMerge, which always needs a person: the rule does not lower it, and the call is held until a person approves');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'is proved when no allow rule names such an operation',
    async () => {
      expect(holdsResult(await verifyWith([['allow', 'PullRequestCreate'], ['ask', 'PullRequestMerge']]))?.verdict.status).toBe('proved');
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
