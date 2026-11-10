import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PREVIOUS_RELEASE } from '../packages/store/src/compat-baseline.ts';
import { repoRoot } from './bundle.ts';

const workflow = fs.readFileSync(`${repoRoot}.github/workflows/ci.yml`, 'utf8');

describe('the CI job that runs the previous release\'s contract suite (H7, 11.7)', () => {
  it('is a job of its own that checks out the tags and runs the one script', () => {
    const job = workflow.slice(workflow.indexOf('\n  compat-previous-release:'));
    expect(job.startsWith('\n  compat-previous-release:')).toBe(true);
    expect(job).toMatch(/fetch-depth: 0/);
    expect(job).toContain('run: node scripts/compat-previous-release.ts');
  });

  it.skipIf(PREVIOUS_RELEASE !== undefined)('reports itself skipped, not passed, while no previous release exists', () => {
    const output = execFileSync(process.execPath, [`${repoRoot}scripts/compat-previous-release.ts`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    expect(output).toContain('::notice title=compat-previous-release::skipped: no previous release is recorded in packages/store/src/compat-baseline.ts');
  });
});
