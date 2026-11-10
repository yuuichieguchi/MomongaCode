import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureMomongaDirs, momongaPaths, ruleEnforcementOf } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, heldMountPoints } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakePolicyFilesystem, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { createEvidencePorts, readGitHead } from '../../src/memory/evidence.ts';
import { createEvidenceRunner } from '../../src/process/evidence-run.ts';
import { fixedSandboxBindings } from '@momonga/runtime';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const HAS_REAL_SANDBOX = process.platform === 'darwin' || process.platform === 'linux';

const KILL_GRACE_MS = 300;

const HOST_SANDBOX_KIND = process.platform === 'darwin' ? ('seatbelt' as const) : ('bubblewrap' as const);

const realSandbox = (tmpRoot: string): Sandbox => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  if (process.platform === 'darwin') return createSeatbeltSandbox({ tmpRoot, killGraceMs: KILL_GRACE_MS });
  if (!fs.existsSync(DEFAULT_BWRAP_PATH)) throw new Error(`the evidence runner test needs real bwrap at ${DEFAULT_BWRAP_PATH}`);
  return createBubblewrapSandbox({ tmpRoot, killGraceMs: KILL_GRACE_MS, journal: createPlaceholderJournal(`${tmpRoot}-journal`), holders: () => heldMountPoints() });
};

const teeingStderr = (inner: Sandbox, captured: string[]): Sandbox => ({
  kind: inner.kind,
  spawn: (command, policy, signal) => {
    const child = inner.spawn(command, policy, signal);
    const tee = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of child.stderr) {
        captured.push(Buffer.from(chunk).toString('utf8'));
        yield chunk;
      }
    };
    return { ...child, stderr: tee() };
  },
});

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  const root = fs.realpathSync(withTempDir(context));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const gitEnv = { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: project, env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  return { home, paths, root, project, git, gitEnv };
};

describe.runIf(HAS_REAL_SANDBOX)('the evidence runner on the real sandbox of this host', () => {
  it('answers git rev-parse HEAD and git merge-base --is-ancestor in a temporary repository', async (context) => {
    const { home, paths, root, project, git } = await setup(context);
    const first = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(project, 'a.txt'), 'two\n');
    git('commit', '-q', '-am', 'two');
    const head = git('rev-parse', 'HEAD');
    const unrelated = git('commit-tree', '-m', 'unrelated', `${head}^{tree}`);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(realSandbox(path.join(root, 'scratch'))), env: { PATH: '/usr/bin:/bin' } })(project);
    const options = { project, trusted: true, run, signal: new AbortController().signal };

    await expect(readGitHead(options)).resolves.toBe(head);
    const ports = createEvidencePorts(options);
    await expect(ports.isAncestor(first)).resolves.toBe(true);
    await expect(ports.isAncestor(head)).resolves.toBe(true);
    await expect(ports.isAncestor(unrelated)).resolves.toBe(false);
    await expect(ports.isAncestor('f'.repeat(40))).resolves.toBeUndefined();
  });

  it('does not start the program a repository names as core.fsmonitor', async (context) => {
    const { home, paths, root, project, git, gitEnv } = await setup(context);
    const script = path.join(root, 'fsmonitor');
    fs.writeFileSync(script, '#!/bin/sh\necho FSMONITOR_RAN >&2\n', { mode: 0o755 });
    git('config', 'core.fsmonitor', script);

    const plain = spawnSync('git', ['status'], { cwd: project, env: gitEnv, encoding: 'utf8' });
    expect(plain.stderr).toContain('FSMONITOR_RAN');

    const captured: string[] = [];
    const sandbox = teeingStderr(realSandbox(path.join(root, 'scratch')), captured);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: { PATH: '/usr/bin:/bin' } })(project);
    const result = await run(
      { argv: ['git', 'status'], cwd: project, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, network: 'deny' },
      new AbortController().signal,
    );
    expect(result.exitCode).toBe(0);
    expect(captured.join('')).not.toContain('FSMONITOR_RAN');
  });
});
