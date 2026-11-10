import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from '@momonga/testkit/child-process';
import type { ChildProcess } from '@momonga/testkit/child-process';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mm-run-lock-setup-'));
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
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith('VITEST') && key !== 'MOMONGA_RUN_LOCK' && key !== 'MOMONGA_RUN_LOCK_WAIT_SECONDS') env[key] = value;
  return { ...env, MOMONGA_DEV_STATE_DIR: state, FIXTURE_OUT: out, ...extra };
};

const startProcess = (command: string, args: string[], cwd: string, env: Record<string, string>): Started => {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

const fixtureRun = (args: string[], extra: Record<string, string> = {}): Started =>
  startProcess(process.execPath, [VITEST, 'run', '--config', 'vitest.config.mjs', ...args], fixture, baseEnv(extra));

const until = async (condition: () => boolean, run: Started): Promise<void> => {
  while (!condition()) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`the process ended before the condition: ${run.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

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
  const run = startProcess(process.execPath, [WRAPPER, runClass, '--', process.execPath, '-e', holderScript(tokenFile, release)], REPO, baseEnv());
  await until(() => fs.existsSync(tokenFile) && lockEntries().some((entry) => entry.endsWith('.info')), run);
  return { run, release, token: fs.readFileSync(tokenFile, 'utf8') };
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

    expect(Object.keys(byName).sort()).toEqual(['e2e', 'packaging', 'unit']);
    for (const name of ['unit', 'packaging', 'e2e']) expect(byName[name]?.globalSetup[0]).toBe('test/support/run-lock.ts');
    expect(byName['unit']?.provide?.['momonga.runClass']).toBe('heavy-when-whole');
    expect(byName['packaging']?.provide?.['momonga.runClass']).toBeUndefined();
    expect(byName['e2e']?.provide?.['momonga.runClass']).toBe('heavy');
  });
});
