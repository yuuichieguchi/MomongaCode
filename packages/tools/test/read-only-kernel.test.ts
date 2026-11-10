import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallOutcome, ResultOutcome } from '@momonga/tools';
import { ruleEnforcementOf } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { computeFileRules } from '@momonga/policy';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';
import type { Builtins } from './builtins/fixtures.ts';
import { HOST_SANDBOX_KIND, makeLayout, policyFor, ruleFor } from './helpers.ts';
import { HAS_REAL_SANDBOX, REFUSED_WRITE_MESSAGE, realSandbox, recordingSandbox, scratchRootOf, withoutRefusedXcrunCacheWrite } from './read-only-support.ts';
import type { RecordedSpawn } from './read-only-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const forced = vi.hoisted(() => ({ decision: { kind: 'allow', source: 'mode', reason: 'forced by the test', basis: 'read_only' } }));

vi.mock('@momonga/policy', async (original) => ({ ...(await original<typeof import('@momonga/policy')>()), decide: () => forced.decision }));

const COMMIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin:/bin' };

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync('/usr/bin/git', args, { cwd, env: { ...COMMIT_ENV, HOME: cwd }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
};

type Stage = Builtins & { spawns: RecordedSpawn[]; bash(command: string, extra?: Parameters<Builtins['run']>[2]): Promise<ResultOutcome['result']> };

const stageIn = async (): Promise<Stage> => {
  const recorded = recordingSandbox(realSandbox(scratchRootOf(makeLayout().root)));
  const built = await makeBuiltins({ sandbox: recorded.sandbox });
  const { project } = built.layout;
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'tracked'), 'one\ntwo\n');
  git(project, 'add', 'tracked');
  git(project, 'commit', '-q', '-m', 'one');
  const bash = async (command: string, extra: Parameters<Builtins['run']>[2] = {}): Promise<ResultOutcome['result']> => {
    const outcome: CallOutcome | undefined = await built.run('Bash', { command }, { env: { ...COMMIT_ENV, HOME: project }, ...extra });
    return resultOf(outcome);
  };
  return { ...built, spawns: recorded.spawns, bash };
};

const snapshot = (directory: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { recursive: true, encoding: 'utf8' })) {
    const absolute = path.join(directory, entry);
    const stat = fs.lstatSync(absolute);
    found[entry] = stat.isSymbolicLink() ? `link:${fs.readlinkSync(absolute)}` : stat.isDirectory() ? 'directory' : fs.readFileSync(absolute).toString('base64');
  }
  return found;
};

const HIDING_OPTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ...['--expand-tabs', '--format', '--max-parents', '--min-parents', '--unified', '-U'].map((option) => ['log', option, '-1'] as const),
  ...['--expand-tabs', '--format', '--unified', '-U'].map((option) => ['show', option, 'HEAD'] as const),
  ...['--abbrev', '--expand-tabs', '--filter', '--format', '--max-parents', '--min-parents', '--missing', '--progress'].map((option) => ['rev-list', option, 'HEAD'] as const),
  ['blame', '--reverse', 'tracked'],
];

describe.runIf(HAS_REAL_SANDBOX)('rule 2 under the real kernel, with decide forced to approve', () => {
  let stage: Stage;

  beforeEach(async () => {
    stage = await stageIn();
  });

  it.each(['git log --format --output=tracked -1', 'git log --format --output=.git/info/exclude -1'])('%s changes nothing', async (command) => {
    const before = snapshot(stage.layout.project);
    await stage.bash(command);
    expect(snapshot(stage.layout.project)).toEqual(before);
  });

  it.each(HIDING_OPTIONS)('git %s %s --output=pwn %s creates no file', async (subcommand, option, trailing) => {
    const before = snapshot(stage.layout.project);
    await stage.bash(`git ${subcommand} ${option} --output=pwn ${trailing}`);
    expect(snapshot(stage.layout.project)).toEqual(before);
  });

  it.each(['echo x >> tracked', ': > pwn', 'mkdir pwn', 'rm tracked', 'mv tracked moved', 'ln -s tracked link', 'git update-ref refs/heads/x HEAD', 'git commit --allow-empty -m x'])('%s changes nothing', async (command) => {
    const before = snapshot(stage.layout.project);
    await stage.bash(command);
    expect(snapshot(stage.layout.project)).toEqual(before);
  });

  it('a write allowed by a file rule outside the workspace is refused too', async () => {
    const wide = stage.layout.outside;
    const rules = [ruleFor(stage.layout)('allow', `Edit(/${wide}/**)`)];
    await stage.bash(`: > ${wide}/pwn`, { rules, sandboxPolicy: { ...policyFor({ layout: stage.layout, rules, tmpDir: stage.tmpDir }), fileRules: computeFileRules(rules, [stage.layout.project], stage.tmpDir, ruleEnforcementOf(HOST_SANDBOX_KIND)) } });
    expect(fs.existsSync(path.join(wide, 'pwn'))).toBe(false);
  });

  it('a diff driver the environment cannot name still cannot write', async () => {
    const script = path.join(stage.layout.outside, 'driver');
    fs.writeFileSync(script, `#!/bin/sh\n: > ${path.join(stage.layout.project, 'pwn')}\n`, { mode: 0o755 });
    git(stage.layout.project, 'config', 'diff.planted.command', script);
    fs.writeFileSync(path.join(stage.layout.project, '.gitattributes'), 'tracked diff=planted\n');
    fs.writeFileSync(path.join(stage.layout.project, 'tracked'), 'changed\n');
    await stage.bash('git diff');
    expect(fs.existsSync(path.join(stage.layout.project, 'pwn'))).toBe(false);
  });

  it('rule 6: a refused write comes back as a failed command, once', async () => {
    const result = await stage.bash(': > pwn');
    expect(result.status).toBe('failed');
    expect(result.output).toContain(REFUSED_WRITE_MESSAGE);
    expect(result.output).toContain('[exit code 1]');
    expect(stage.spawns).toHaveLength(1);
  });

  describe('the temporary directory is enough', () => {
    const expectReadOnly = (): void => {
      expect(stage.spawns[0]?.policy.writableRoots).not.toContain(stage.layout.project);
    };

    it('a file can be written and read back in TMPDIR', async () => {
      const result = await stage.bash('echo kept > "$TMPDIR/p"; cat "$TMPDIR/p"');
      expectReadOnly();
      expect(result).toMatchObject({ status: 'completed', output: 'kept' });
    });

    it('sort spills to a temporary file', async () => {
      fs.writeFileSync(path.join(stage.layout.project, 'big'), Array.from({ length: 50_000 }, (_, index) => `${49_999 - index}`.padStart(8, '0')).join('\n'));
      const result = await stage.bash('sort -S 64K big | head -2');
      expectReadOnly();
      expect(result).toMatchObject({ status: 'completed', output: '00000000\n00000001' });
    });

    it.each([
      ['ls', 'tracked'],
      ['find . -name tracked', './tracked'],
      ['grep -c one tracked', '1'],
      ['git log -1 --format=%s', 'one'],
    ])('%s works', async (command, output) => {
      const result = await stage.bash(command);
      expectReadOnly();
      expect(result).toMatchObject({ status: 'completed' });
      expect(withoutRefusedXcrunCacheWrite(result.output, process.platform)).toBe(output);
    });

    it('rg works', async () => {
      const result = await stage.bash('rg -c one tracked', { env: { ...COMMIT_ENV, HOME: stage.layout.project, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } });
      expectReadOnly();
      expect(result).toMatchObject({ status: 'completed', output: '1' });
    });
  });

  it('the policy has no writable root at all and TMPDIR is not the session temporary directory', async () => {
    const result = await stage.bash('printf %s "$TMPDIR"');
    expect(stage.spawns[0]?.policy.writableRoots).toEqual([]);
    expect(result.output).not.toBe('');
    expect(result.output.startsWith(stage.tmpDir)).toBe(false);
  });

  it('the session temporary directory is not writable', async () => {
    const result = await stage.bash(`: > ${stage.tmpDir}/pwn`);
    expect(result.status).toBe('failed');
    expect(result.output).toContain(REFUSED_WRITE_MESSAGE);
    expect(fs.existsSync(path.join(stage.tmpDir, 'pwn'))).toBe(false);
  });

  it('a file written to TMPDIR does not outlive the call', async () => {
    const written = await stage.bash('echo kept > "$TMPDIR/p"; printf %s "$TMPDIR"');
    const scratch = written.output.split('\n').at(-1) as string;
    expect(fs.existsSync(path.join(scratch, 'p'))).toBe(false);
  });
});
