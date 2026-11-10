import { describe, expect, it } from 'vitest';
import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { hostFilesystemOf } from '@momonga/testkit';
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

const verifyWith = (specs: readonly RuleSpec[]): Promise<VerificationReport> => {
  const layout = makeLayout();
  const fileSystem = caseSensitiveFs();
  const roots = [layout.project];
  const request = {
    rules: rulesOf(layout, specs),
    roots,
    mode: 'manual',
    home: layout.home,
    cwd: layout.project,
    protectedSet: protectedSetFor(roots, fileSystem),
    fs: hostFilesystemOf(fileSystem),
    secretLocations: [sshLocation(layout)],
    exemptDirectory: null,
    enforcement: ruleEnforcementOf('none'),
    budgetMs: 120_000,
    supersededForms: SUPERSEDED,
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
