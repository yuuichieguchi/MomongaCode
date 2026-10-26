import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxPolicy } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

type Layout = 'plain' | 'symlinked';

const writeTool = (target: string, runs: string[]) =>
  makeTool('PathTool', {
    kind: 'edit',
    sideEffect: 'write',
    subject: () => ({ kind: 'path', tool: 'PathTool', paths: [target], access: 'write' }),
    execute: async () => {
      runs.push(target);
      return { status: 'completed', output: 'touched' };
    },
  });

const launcherHarness = (layout: Layout) => {
  const harness = makeHarness();
  const home = harness.layout.home;
  const unprotectedTarget = path.join(harness.layout.outside, 'momonga');
  fs.writeFileSync(unprotectedTarget, 'binary');
  if (layout === 'plain') {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  } else {
    fs.mkdirSync(path.join(home, 'dotfiles', 'local', 'bin'), { recursive: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'local'), path.join(home, '.local'));
  }
  const launcher = path.join(home, '.local', 'bin', 'momonga');
  fs.symlinkSync(unprotectedTarget, launcher);
  const sessionsTmpRoot = path.join(harness.layout.root, 'sessions');
  const tmpDir = path.join(sessionsTmpRoot, 'one');
  fs.mkdirSync(tmpDir, { recursive: true });
  const sandboxPolicy = buildSandboxPolicy({ roots: [home], home, tmpDir, sessionsTmpRoot });
  const rewriteRecord = (content: string): void => {
    const file = path.join(home, '.momonga', 'bin', 'launcher-links');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const attempt = async (target: string) => {
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(writeTool(target, runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        roots: [home],
        session: { cwd: home, readLedger: new Map() },
        sandboxPolicy,
      }),
    );
    return { outcome: outcome as { kind: string; result: { status: string; output: string } }, runs };
  };
  return { home, launcher, attempt, rewriteRecord };
};

const expectRefused = ({ outcome, runs }: Awaited<ReturnType<ReturnType<typeof launcherHarness>['attempt']>>): void => {
  expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
  expect(outcome.result.output).toMatch(/^Permission denied: /);
  expect(runs).toEqual([]);
};

describe('executor: the launcher link is always write-denied without following it', () => {
  it('refuses a write to the lexical link path whose target lies outside every protected area', async () => {
    const { launcher, attempt } = launcherHarness('plain');
    expectRefused(await attempt(launcher));
  });

  it('refuses a write to ~/.local/bin, which would remove or replace the link', async () => {
    const { home, attempt } = launcherHarness('plain');
    expectRefused(await attempt(path.join(home, '.local', 'bin')));
  });

  it('refuses a write to ~/.local', async () => {
    const { home, attempt } = launcherHarness('plain');
    expectRefused(await attempt(path.join(home, '.local')));
  });

  it('refuses the lexical link and the canonical-parent link when ~/.local is a symlink', async () => {
    const { home, launcher, attempt } = launcherHarness('symlinked');
    expectRefused(await attempt(launcher));
    expectRefused(await attempt(path.join(home, 'dotfiles', 'local', 'bin', 'momonga')));
  });

  it('refuses writes to the lexical and canonical ancestors when ~/.local is a symlink', async () => {
    const { home, attempt } = launcherHarness('symlinked');
    for (const ancestor of [
      path.join(home, '.local'),
      path.join(home, '.local', 'bin'),
      path.join(home, 'dotfiles'),
      path.join(home, 'dotfiles', 'local'),
      path.join(home, 'dotfiles', 'local', 'bin'),
    ]) {
      expectRefused(await attempt(ancestor));
    }
  });

  it('still allows a write to another file in ~/.local/bin', async () => {
    const { home, attempt } = launcherHarness('plain');
    const other = path.join(home, '.local', 'bin', 'other-tool');
    const { outcome, runs } = await attempt(other);
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(runs).toEqual([other]);
  });

  it('still refuses writes into the momonga root and the keychains', async () => {
    const { home, attempt } = launcherHarness('plain');
    expectRefused(await attempt(path.join(home, '.momonga', 'x')));
    expectRefused(await attempt(path.join(home, 'Library', 'Keychains', 'x')));
  });
});

describe('executor: the guard follows the policy, not a later launcher-links', () => {
  it('does not protect a link recorded after the policy was built', async () => {
    const { home, attempt, rewriteRecord } = launcherHarness('plain');
    const recorded = path.join(home, 'late', 'momonga');
    fs.mkdirSync(path.dirname(recorded));
    rewriteRecord(`${recorded}\n`);
    const { outcome, runs } = await attempt(recorded);
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(runs).toEqual([recorded]);
  });
});
