import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from '@momonga/testkit/child-process';
import type { ChildProcess } from '@momonga/testkit/child-process';
import { createTempDir, pollUntil, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { killGroup } from '../../scripts/support/cpu-budget.ts';
import { RUN_LOCK_DEFAULT_WAIT_SECONDS, RUN_LOCK_EXIT } from '../../scripts/support/run-lock.ts';
import config from '../../vitest.config.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SETUP = path.join(REPO, 'test', 'support', 'run-lock.ts');
const TIER = path.join(REPO, 'test', 'formal', 'tier.ts');
const VITEST = path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs');
const WRAPPER = path.join(REPO, 'scripts', 'run-lock.ts');
const TESTKIT_CHILD_PROCESS = path.join(REPO, 'packages', 'testkit', 'src', 'child-process.ts');

type Started = { child: ChildProcess; output: () => string; exit: Promise<number | null> };

let root = '';
let fixture = '';
let out = '';
let state = '';
const started: Started[] = [];
const releaseFiles: string[] = [];

const fixtureTest = (importLine: string): string =>
  [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `import { execFileSync } from '${TESTKIT_CHILD_PROCESS}';`,
    importLine,
    "test('writes the run lock token', () => {",
    "  const out = process.env['FIXTURE_OUT'] ?? '';",
    '  const name = path.basename(import.meta.filename);',
    "  fs.writeFileSync(path.join(out, `${name}.token`), process.env['MOMONGA_RUN_LOCK'] ?? '');",
    "  fs.writeFileSync(path.join(out, `${name}.child`), execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.MOMONGA_RUN_LOCK ?? \"\")'], { encoding: 'utf8' }));",
    '});',
    '',
  ].join('\n');

beforeEach(() => {
  root = createTempDir();
  fixture = path.join(root, 'fixture');
  out = path.join(root, 'out');
  state = path.join(root, 'state');
  fs.mkdirSync(out);
  for (const sub of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(fixture, sub), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'a', 'x.test.ts'), fixtureTest(''));
  fs.writeFileSync(path.join(fixture, 'a', 'y.test.ts'), fixtureTest(''));
  fs.writeFileSync(path.join(fixture, 'b', 'z.test.ts'), fixtureTest(''));
  fs.writeFileSync(path.join(fixture, 'c', 'w.test.ts'), fixtureTest(''));
  fs.writeFileSync(path.join(fixture, 'd', 'tier.test.ts'), fixtureTest(`import type * as Tier from '${path.relative(path.join(fixture, 'd'), TIER)}';`));
  const project = (name: string, runClass?: string) => ({
    extends: true,
    test: { name, include: [`${name}/**/*.test.ts`], globalSetup: [SETUP], ...(runClass === undefined ? {} : { provide: { 'momonga.runClass': runClass } }) },
  });
  fs.writeFileSync(
    path.join(fixture, 'vitest.config.mjs'),
    `export default ${JSON.stringify({ test: { globals: true, pool: 'forks', projects: [project('a', 'heavy-when-whole'), project('b', 'heavy'), project('c'), project('d')] } })};\n`,
  );
});

afterEach(async () => {
  for (const file of releaseFiles.splice(0)) fs.writeFileSync(file, '');
  for (const run of started.splice(0)) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
    await run.exit;
    if (run.child.pid !== undefined) killGroup(run.child.pid);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

type ChildEnv = Record<string, string | undefined>;

const NO_WAIT_NAMED: ChildEnv = { MOMONGA_RUN_LOCK_WAIT_SECONDS: undefined };

const baseEnv = (extra: ChildEnv = {}): ChildEnv => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('VITEST') && key !== 'MOMONGA_RUN_LOCK') env[key] = value;
  return { ...env, MOMONGA_RUN_LOCK_WAIT_SECONDS: '0', MOMONGA_RUN_CPU_BUDGET_SECONDS: '600', MOMONGA_DEV_STATE_DIR: state, FIXTURE_OUT: out, ...extra };
};

const startProcess = (command: string, args: string[], cwd: string, env: ChildEnv): Started => {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exit = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const run = { child, output: () => output, exit };
  started.push(run);
  return run;
};

const fixtureRun = (args: string[], extra: ChildEnv = {}): Started =>
  startProcess(process.execPath, [VITEST, 'run', '--config', 'vitest.config.mjs', ...args], fixture, baseEnv(extra));

const until = (condition: () => boolean, run: Started): Promise<void> =>
  pollUntil(
    () => {
      if (condition()) return true;
      if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`the process ended before the condition: ${run.output()}`);
      return false;
    },
    { description: 'the condition of the run lock case', boundMs: REAL_PROCESS_TEST_TIMEOUT_MS },
  );

const lockEntries = (): string[] => (fs.existsSync(path.join(state, 'run-lock')) ? fs.readdirSync(path.join(state, 'run-lock')).sort() : []);

const holderScript = (tokenFile: string, release: string): string =>
  [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(tokenFile)}, process.env.MOMONGA_RUN_LOCK ?? '');`,
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)}) || !fs.existsSync(${JSON.stringify(path.dirname(release))})) clearInterval(timer); }, 10);`,
  ].join('\n');

const hold = async (runClass: 'heavy' | 'light'): Promise<{ run: Started; release: string; token: string }> => {
  const release = path.join(root, `release-${runClass}`);
  const tokenFile = path.join(root, `token-${runClass}`);
  releaseFiles.push(release);
  const run = startProcess(process.execPath, [WRAPPER, runClass, '--budget-cpu-seconds', '30', '--', process.execPath, '-e', holderScript(tokenFile, release)], root, baseEnv());
  await until(() => fs.existsSync(tokenFile) && lockEntries().some((entry) => entry.endsWith('.info')), run);
  return { run, release, token: fs.readFileSync(tokenFile, 'utf8') };
};

const DETACHED_HEAD = '0123456789abcdef0123456789abcdef01234567\n';

const asWorktreeAt = (directory: string, head: string): void => {
  const gitDir = path.join(root, 'common', 'worktrees', path.basename(directory));
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), head);
  fs.writeFileSync(path.join(directory, '.git'), `gitdir: ${gitDir}\n`);
};

const tokenFiles = (): string[] => fs.readdirSync(out).filter((name) => name.endsWith('.token'));

describe('the run lock global setup classifies a vitest run and holds its lock', () => {
  it.each([
    ['one file of a project that is heavy only when whole', ['a/x.test.ts'], 'x.test.ts', 'light.'],
    ['every project whole', [], 'x.test.ts', 'heavy.'],
    ['the whole of a project that is heavy when whole', ['--project', 'a'], 'y.test.ts', 'heavy.'],
    ['one file of a project that is heavy in every selection', ['b/z.test.ts'], 'z.test.ts', 'heavy.'],
    ['one file whose imports reach the tier runner', ['d/tier.test.ts'], 'tier.test.ts', 'heavy.'],
    ['the whole of a project with no class', ['--project', 'c'], 'w.test.ts', 'light.'],
  ])('TB37 gives %s the expected class', async (_case, args, file, prefix) => {
    const run = fixtureRun(args);

    expect(await run.exit).toBe(0);
    const token = fs.readFileSync(path.join(out, `${file}.token`), 'utf8');
    expect(token.startsWith(prefix)).toBe(true);
    expect(token).toMatch(/^(heavy|light)\.[0-9a-f]{16}$/);
    expect(fs.readFileSync(path.join(out, `${file}.child`), 'utf8')).toBe(token);
  });

  it.each([
    ['a worktree on fix/x', 'ref: refs/heads/fix/x\n'],
    ['a worktree on a detached HEAD', DETACHED_HEAD],
  ])('runs a heavy vitest run whose root is %s under the heavy lock', async (_case, head) => {
    asWorktreeAt(fixture, head);

    const run = fixtureRun([]);

    expect(await run.exit).toBe(0);
    expect(fs.readFileSync(path.join(out, 'x.test.ts.token'), 'utf8')).toMatch(/^heavy\.[0-9a-f]{16}$/);
  });

  it('runs a light vitest run whose root is a worktree on any branch', async () => {
    asWorktreeAt(fixture, 'ref: refs/heads/fix/x\n');

    const run = fixtureRun(['a/x.test.ts']);

    expect(await run.exit).toBe(0);
    expect(fs.readFileSync(path.join(out, 'x.test.ts.token'), 'utf8')).toMatch(/^light\.[0-9a-f]{16}$/);
  });

  it('TB38 refuses a heavy run while a wrapper holds the heavy lock, before any test file runs', async () => {
    const holder = await hold('heavy');

    const run = fixtureRun([]);

    expect(await run.exit).not.toBe(0);
    expect(run.output()).toContain(`run-lock: heavy run refused: held by heavy pid ${holder.run.child.pid}`);
    expect(tokenFiles()).toEqual([]);
  });

  it('TB39 waits under MOMONGA_RUN_LOCK_WAIT_SECONDS and runs once the holder releases', async () => {
    const holder = await hold('heavy');
    const run = fixtureRun([], { MOMONGA_RUN_LOCK_WAIT_SECONDS: '60' });
    await until(() => run.output().includes('run-lock: heavy run waits up to 60 s for '), run);
    fs.writeFileSync(holder.release, '');

    expect(await run.exit).toBe(0);
    expect(run.output()).toContain('run-lock: heavy run starts after waiting ');
    expect(tokenFiles().length).toBeGreaterThan(0);
  });

  it('waits up to the default limit when no wait variable is set: a light run beside a heavy holder is not refused at once', async () => {
    const holder = await hold('heavy');
    const run = fixtureRun(['a/x.test.ts'], NO_WAIT_NAMED);
    await until(() => run.output().includes(`run-lock: light run waits up to ${RUN_LOCK_DEFAULT_WAIT_SECONDS} s for heavy pid ${holder.run.child.pid} `), run);
    expect(tokenFiles()).toEqual([]);
    fs.writeFileSync(holder.release, '');

    expect(await run.exit).toBe(0);
    expect(fs.readFileSync(path.join(out, 'x.test.ts.token'), 'utf8')).toMatch(/^light\.[0-9a-f]{16}$/);
  });

  it('TB40 runs under a live heavy token without a new lock file', async () => {
    const holder = await hold('heavy');
    const before = lockEntries();

    const run = fixtureRun([], { MOMONGA_RUN_LOCK: holder.token });

    expect(await run.exit).toBe(0);
    expect(lockEntries()).toEqual(before);
    expect(fs.readFileSync(path.join(out, 'x.test.ts.token'), 'utf8')).toBe(holder.token);
  });

  it('TB40 refuses a whole-project run under a live light token', async () => {
    const holder = await hold('light');

    const run = fixtureRun([], { MOMONGA_RUN_LOCK: holder.token });

    expect(await run.exit).not.toBe(0);
    expect(run.output()).toContain('run-lock: a heavy run cannot start inside a light run');
    expect(tokenFiles()).toEqual([]);
  });

  it('TB41 refuses a wrong MOMONGA_RUN_LOCK_WAIT_SECONDS', async () => {
    const run = fixtureRun([], { MOMONGA_RUN_LOCK_WAIT_SECONDS: 'abc' });

    expect(await run.exit).not.toBe(0);
    expect(run.output()).toContain('run-lock: MOMONGA_RUN_LOCK_WAIT_SECONDS must be a whole number of seconds, got "abc"');
    expect(tokenFiles()).toEqual([]);
  });

  it('TB42 refuses the run when the state directory is under a regular file', async () => {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, '');

    const run = fixtureRun([], { MOMONGA_DEV_STATE_DIR: path.join(blocker, 'state') });

    expect(await run.exit).not.toBe(0);
    expect(run.output()).toContain('run-lock: cannot use ');
    expect(tokenFiles()).toEqual([]);
  });

  it('TB43 refuses a vitest that does not expose the selected files', async () => {
    const { default: setup } = (await import('./run-lock.ts')) as { default: (project: unknown) => Promise<unknown> };

    await expect(setup({ vitest: { state: {}, projects: [] } })).rejects.toThrow(new Error('run-lock: this vitest no longer exposes the selected test files'));
  });

  it('TB44 puts the setup first in every project and declares the classes', () => {
    const projects = (config.test?.projects ?? []) as Array<{ test: { name: string; globalSetup: string[]; provide?: Record<string, unknown> } }>;
    const byName = Object.fromEntries(projects.map((project) => [project.test.name, project.test]));

    expect(Object.keys(byName).sort()).toEqual(['calibration', 'e2e', 'packaging', 'unit']);
    for (const name of ['unit', 'packaging', 'e2e', 'calibration']) expect(byName[name]?.globalSetup[0]).toBe('test/support/run-lock.ts');
    expect(byName['unit']?.provide?.['momonga.runClass']).toBe('heavy-when-whole');
    expect(byName['packaging']?.provide?.['momonga.runClass']).toBe('heavy');
    expect(byName['e2e']?.provide?.['momonga.runClass']).toBe('heavy');
    expect(byName['calibration']?.provide?.['momonga.runClass']).toBe('heavy');
  });
});

const groupMembers = (pgid: number): number[] =>
  execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, group]) => group === pgid)
    .map(([pid]) => pid as number);

const groupGone = (pgid: number): Promise<void> =>
  pollUntil(() => groupMembers(pgid).length === 0, { description: `process group ${pgid} to be gone`, boundMs: REAL_PROCESS_TEST_TIMEOUT_MS });

const heavyIsFree = (): number | null =>
  spawnSync(process.execPath, [WRAPPER, 'heavy', '--budget-cpu-seconds', '5', '--', 'true'], { cwd: root, env: baseEnv(), stdio: 'ignore' }).status;

const pidIn = async (file: string, run: Started): Promise<number> => {
  await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '', run);
  return Number(fs.readFileSync(file, 'utf8').trim());
};

describe('the lock runner bounds the command it holds the lock for', () => {
  it.each([
    ['a worktree on fix/x', 'ref: refs/heads/fix/x\n'],
    ['a worktree on a detached HEAD', DETACHED_HEAD],
  ])('runs the command of a heavy wrapper started in %s and ends with its exit code', async (_case, head) => {
    const worktree = path.join(root, 'worktree');
    const marker = path.join(root, 'ran');
    fs.mkdirSync(path.join(worktree, 'nested'), { recursive: true });
    asWorktreeAt(worktree, head);
    const heavy = startProcess(process.execPath, [WRAPPER, 'heavy', '--budget-cpu-seconds', '5', '--', 'sh', '-c', `echo ran > ${marker}; exit 3`], path.join(worktree, 'nested'), baseEnv());

    expect(await heavy.exit).toBe(3);
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran\n');
    expect(heavyIsFree()).toBe(0);
  });

  it('refuses a command with no CPU budget and leaves the lock free', async () => {
    const run = startProcess(process.execPath, [WRAPPER, 'heavy', '--', 'true'], root, baseEnv());

    expect(await run.exit).toBe(64);
    expect(run.output()).toContain('--budget-cpu-seconds <seconds>');
    expect(heavyIsFree()).toBe(0);
  });

  it('ends the whole group of a command that burns CPU past its budget, names the budget, and frees the lock', async () => {
    const pidFile = path.join(root, 'pid');
    const run = startProcess(process.execPath, [WRAPPER, 'heavy', '--budget-cpu-seconds', '1', '--', 'sh', '-c', `echo $$ > ${pidFile}; while :; do :; done`], root, baseEnv());
    const pgid = await pidIn(pidFile, run);

    expect(await run.exit).toBe(RUN_LOCK_EXIT.cpuBudget);
    expect(run.output()).toContain('run-lock: the command passed its CPU budget of 1 s');
    await groupGone(pgid);
    expect(heavyIsFree()).toBe(0);
  });

  it('counts a grandchild toward the budget and ends it with the group', async () => {
    const pidFile = path.join(root, 'pid');
    const grandchildFile = path.join(root, 'grandchild');
    const script = `echo $$ > ${pidFile}; sh -c 'while :; do :; done' & echo $! > ${grandchildFile}; wait`;
    const run = startProcess(process.execPath, [WRAPPER, 'light', '--budget-cpu-seconds', '1', '--', 'sh', '-c', script], root, baseEnv());
    const pgid = await pidIn(pidFile, run);
    const grandchild = await pidIn(grandchildFile, run);

    expect(await run.exit).toBe(RUN_LOCK_EXIT.cpuBudget);
    await groupGone(pgid);
    expect(groupMembers(pgid)).not.toContain(grandchild);
    expect(heavyIsFree()).toBe(0);
  });

  it('ends the group and frees the lock when the process that started the runner is gone', async () => {
    const pidFile = path.join(root, 'pid');
    const starter = startProcess('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(WRAPPER)} heavy --budget-cpu-seconds 600 -- sh -c 'echo $$ > ${pidFile}; sleep 600' & wait`], root, baseEnv());
    const pgid = await pidIn(pidFile, starter);
    starter.child.kill('SIGKILL');
    await starter.exit;

    await groupGone(pgid);
    await pollUntil(() => heavyIsFree() === 0, { description: 'the heavy lock to be free', boundMs: REAL_PROCESS_TEST_TIMEOUT_MS });
  });
});

describe('the run lock global setup bounds the vitest run that holds the lock', () => {
  it('refuses a run whose projects record no CPU budget when none is given', async () => {
    const run = fixtureRun(['a/x.test.ts'], { MOMONGA_RUN_CPU_BUDGET_SECONDS: undefined });

    expect(await run.exit).not.toBe(0);
    expect(run.output()).toContain('run-lock: no CPU budget for project a');
    expect(tokenFiles()).toEqual([]);
  });

  it('ends the vitest run that burns CPU past its budget and frees the lock', async () => {
    fs.writeFileSync(path.join(fixture, 'b', 'z.test.ts'), "test('burns', () => { for (;;) {} });\n");
    const run = fixtureRun(['b/z.test.ts'], { MOMONGA_RUN_CPU_BUDGET_SECONDS: '2' });

    expect(await run.exit).not.toBe(0);
    expect(run.output()).toContain('run-lock: the command passed its CPU budget of 2 s');
    expect(heavyIsFree()).toBe(0);
  });
});
