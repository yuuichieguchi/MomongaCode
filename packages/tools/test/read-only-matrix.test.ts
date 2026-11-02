import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { protectedSetFor } from '@momonga/foundation';
import { EMPTY_GLOB_TABLE, computeFileRules, createGlobDeadline, decide, prepareGlobs, settleGlobs } from '@momonga/policy';
import type { Sandbox } from '@momonga/sandbox';
import { TEST_SEARCH_PATH, isWritableFor } from '@momonga/testkit';
import { buildSandboxPolicy, createPolicyFilesystem } from '@momonga/tools';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';
import { collect } from './read-only-collect.ts';
import { approvableForms, exitStatusOf, normalised, outputDiffersByNature, seesOnlyItsOwnNamespace } from './read-only-forms.ts';
import { HAS_REAL_SANDBOX, realSandbox, recordingSandbox } from './read-only-support.ts';
import type { RecordedSpawn } from './read-only-support.ts';

const FIXED_DATE = '2001-01-01T00:00:00Z';
const GLOB_BUDGET_MS = 60_000;
const PLAIN_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

const FORMS = approvableForms(process.platform);
const OTHER_PLATFORM: NodeJS.Platform = process.platform === 'darwin' ? 'linux' : 'darwin';

describe.runIf(HAS_REAL_SANDBOX)('every approvable command form prints the same under the read-only sandbox', () => {
  let base = '';
  let project = '';
  let home = '';
  let plainEnv: NodeJS.ProcessEnv = {};
  let inner: Sandbox;
  let spawned: RecordedSpawn;
  const hostFilesystem = createPolicyFilesystem();
  const filesystem = hostFilesystem;

  const git = (...args: string[]): void => {
    const result = spawnSync('/usr/bin/git', args, { cwd: project, env: { ...plainEnv, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };

  const decideOn = async (command: string, filesystem = hostFilesystem) => {
    const roots = [project];
    const subject = { kind: 'command', tool: 'Bash', command } as const;
    const globs = await prepareGlobs({ expand: filesystem.expandGlob, platform: filesystem.platform, subject, cwd: project, home, deadline: createGlobDeadline(GLOB_BUDGET_MS), signal: new AbortController().signal });
    return decide({
      tool: { name: 'Bash', kind: 'execute', sideEffect: 'exec' },
      subject,
      mode: 'default',
      rules: [],
      roots,
      home,
      cwd: project,
      fileRules: computeFileRules([], roots, null),
      protectedSet: protectedSetFor(roots, filesystem),
      fs: settleGlobs(filesystem, globs ?? EMPTY_GLOB_TABLE),
      searchPath: TEST_SEARCH_PATH,
      isWritable: isWritableFor(roots),
    });
  };

  const runPlain = (command: string) => {
    const done = spawnSync('/bin/bash', ['-c', command], { cwd: project, env: plainEnv, encoding: 'utf8', maxBuffer: PLAIN_OUTPUT_LIMIT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout: done.stdout, stderr: done.stderr, status: exitStatusOf(done) };
  };

  const sandboxed = async (command: string) => {
    const { markerFile: _spentMarker, ...replayed } = spawned.command;
    const child = inner.spawn({ ...replayed, argv: ['/bin/bash', '-c', command], cwd: project }, spawned.policy, new AbortController().signal);
    const [stdout, stderr, exit] = await Promise.all([collect(child.stdout), collect(child.stderr), child.exited]);
    return { stdout, stderr, status: exitStatusOf({ status: exit.code, signal: exit.signal as NodeJS.Signals | null }) };
  };

  beforeAll(async () => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-matrix-')));
    project = path.join(base, 'project');
    home = path.join(base, 'home');
    const tmpDir = path.join(base, 'sessions', 'session-0');
    for (const directory of [project, home, tmpDir, path.join(project, 'sub')]) fs.mkdirSync(directory, { recursive: true });
    plainEnv = { HOME: home, PATH: TEST_SEARCH_PATH, LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    fs.writeFileSync(path.join(project, 'tracked'), 'one\ntwo\n');
    fs.writeFileSync(path.join(project, 'stable'), 'same\n');
    fs.writeFileSync(path.join(project, 'sub', 'inner'), 'inner\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    git('tag', 'v1');
    fs.appendFileSync(path.join(project, 'tracked'), 'three\n');
    fs.writeFileSync(path.join(project, 'untracked'), 'new\n');
    fs.utimesSync(path.join(project, 'stable'), new Date(FIXED_DATE), new Date(FIXED_DATE));

    inner = realSandbox(path.join(base, 'sandbox-tmp'));
    const recorded = recordingSandbox(inner);
    const built = await makeBuiltins({ sandbox: recorded.sandbox });
    const roots = [project];
    const sandboxPolicy = buildSandboxPolicy({ roots, home, tmpDir, sessionsTmpRoot: path.join(base, 'sessions'), fileRules: computeFileRules([], roots, tmpDir), protectedSet: protectedSetFor(roots, filesystem), network: 'deny' });
    resultOf(await built.run('Bash', { command: 'pwd' }, { env: plainEnv as Record<string, string>, roots, home, tmpDir, sandboxPolicy, session: { cwd: project, readLedger: new Map() } }));
    spawned = recorded.spawns[0] as RecordedSpawn;
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('the generator covers the spec tables', () => {
    expect(FORMS.length).toBeGreaterThan(1000);
    for (const expected of ['sort tracked', 'ls --color=1 tracked', 'git log -1 --oneline', 'git status --short', 'grep -c one tracked']) expect(FORMS.filter((form) => form.startsWith(expected.split(' ').slice(0, 2).join(' '))).length).toBeGreaterThan(0);
  });

  it('generates the forms of the Darwin table and of the GNU table, and ps only from the GNU one', () => {
    const darwin = approvableForms('darwin');
    const linux = approvableForms('linux');
    expect(darwin.length).toBeGreaterThan(1000);
    expect(linux.length).toBeGreaterThan(1000);
    expect(darwin.some((form) => /^ps( |$)/.test(form))).toBe(false);
    expect(linux.some((form) => /^ps( |$)/.test(form))).toBe(true);
    for (const expected of ['git branch --list', 'git tag --list', 'git remote -v', 'git reflog show']) {
      expect(darwin.some((form) => form.startsWith(expected))).toBe(true);
      expect(linux.some((form) => form.startsWith(expected))).toBe(true);
    }
  });

  it.each(approvableForms(OTHER_PLATFORM))(`%s is approved on the ${OTHER_PLATFORM} table, which runs on its own platform`, async (command) => {
    const decision = await decideOn(command, createPolicyFilesystem(OTHER_PLATFORM));
    expect(decision.kind).toBe('allow');
    expect(decision.basis).toBe('read_only');
  });

  it.each(FORMS)('%s', async (command) => {
    const decision = await decideOn(command);
    expect(decision.kind).toBe('allow');
    expect(decision.basis).toBe('read_only');
    expect(spawned.policy.writableRoots).not.toContain(project);
    const plain = runPlain(command);
    const result = await sandboxed(command);
    if (seesOnlyItsOwnNamespace(command)) {
      expect([0, 1]).toContain(result.status);
      return;
    }
    if (outputDiffersByNature(command)) {
      expect(result.status).toBe(plain.status);
      return;
    }
    expect({ stdout: normalised(command, result.stdout), stderr: normalised(command, result.stderr), status: result.status }).toEqual({
      stdout: normalised(command, plain.stdout),
      stderr: normalised(command, plain.stderr),
      status: plain.status,
    });
  });

  it.runIf(process.platform === 'linux')('ps inside the sandbox lists only the sandbox own processes, so its output cannot match the host', async () => {
    const outside = runPlain('ps -e -o pid=').stdout.trim().split('\n').length;
    const inside = (await sandboxed('ps -e -o pid=')).stdout.trim().split('\n');
    expect(outside).toBeGreaterThan(inside.length);
    expect(inside.length).toBeLessThanOrEqual(4);
  });
});
