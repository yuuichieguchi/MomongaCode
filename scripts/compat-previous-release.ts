import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIOUS_RELEASE } from '../packages/store/src/compat-baseline.ts';
import { buildCompatTemplate } from '../packages/store/test/compat/contract-writer.ts';

const BASELINE_FILE = 'packages/store/src/compat-baseline.ts';
const CONTRACT_SUITE = 'packages/store/test/compat/contract.test.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const report = (line: string): void => {
  process.stdout.write(`${line}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') fs.appendFileSync(summary, `${line}\n`);
};

const run = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void => {
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });
};

if (PREVIOUS_RELEASE === undefined) {
  report(`::notice title=compat-previous-release::skipped: no previous release is recorded in ${BASELINE_FILE}`);
} else {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-compat-ci-'));
  fs.chmodSync(work, 0o700);
  const template = path.join(work, 'template.db');
  buildCompatTemplate(template, 'current');
  const previous = path.join(work, 'previous');
  run('git', ['worktree', 'add', '--detach', previous, PREVIOUS_RELEASE.tag], repoRoot);
  try {
    run('npm', ['ci', '--ignore-scripts'], previous);
    run('npx', ['vitest', 'run', '--project', 'unit', CONTRACT_SUITE], previous, { ...process.env, MOMONGA_COMPAT_DB_TEMPLATE: template });
    report(`compat-previous-release: the contract suite of ${PREVIOUS_RELEASE.tag} passed against this release's schema`);
  } finally {
    run('git', ['worktree', 'remove', '--force', previous], repoRoot);
    fs.rmSync(work, { recursive: true, force: true });
  }
}
