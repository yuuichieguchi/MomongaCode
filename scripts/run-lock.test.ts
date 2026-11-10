import fs from 'node:fs';
import path from 'node:path';
import { spawn } from '@momonga/testkit/child-process';
import type { ChildProcess } from '@momonga/testkit/child-process';
import { isProcessAlive } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repoRoot } from './bundle.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const WRAPPER = path.join(repoRoot, 'scripts', 'run-lock.ts');
const HOLDER = path.join(repoRoot, 'scripts', 'support', 'run-lock-holder.ts');
const USAGE = 'usage: node scripts/run-lock.ts <heavy|light> [--wait <seconds>] -- <command> [args...]';

type Started = { child: ChildProcess; stderr: () => string; stdout: () => string; exit: Promise<number | null>; processGone: Promise<void> };

let root = '';
let state = '';
let events = '';
const started: Started[] = [];
const releaseFiles: string[] = [];

beforeEach(() => {
  root = createTempRoot();
  state = path.join(root, 'state');
  events = path.join(root, 'events');
  fs.writeFileSync(events, '');
});

afterEach(async () => {
  for (const file of releaseFiles.splice(0)) fs.writeFileSync(file, '');
  for (const run of started.splice(0)) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
    await run.exit;
  }
  removeTempRoot(root);
});

const childEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'MOMONGA_RUN_LOCK' && key !== 'MOMONGA_RUN_LOCK_WAIT_SECONDS') env[key] = value;
  return { ...env, MOMONGA_DEV_STATE_DIR: state, ...extra };
};

const wrapper = (args: string[], extra: Record<string, string> = {}): Started => {
  const child = spawn(process.execPath, [WRAPPER, ...args], { cwd: repoRoot, env: childEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const processGone = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const run = { child, stderr: () => stderr, stdout: () => stdout, exit, processGone };
  started.push(run);
  return run;
};

const releaseFileOf = (name: string): string => {
  const file = path.join(root, `release-${name}`);
  releaseFiles.push(file);
  return file;
};

const holderCommand = (name: string, release: string): string[] => [process.execPath, HOLDER, events, name, release];

const lockDir = (): string => path.join(state, 'run-lock');

const lockEntries = (): string[] => (fs.existsSync(lockDir()) ? fs.readdirSync(lockDir()).sort() : []);

const eventLines = (): string[] => fs.readFileSync(events, 'utf8').split('\n').filter((line) => line !== '');

const until = async (condition: () => boolean, run?: Started): Promise<void> => {
  while (!condition()) {
    if (run !== undefined && (run.child.exitCode !== null || run.child.signalCode !== null)) throw new Error(`the wrapper ended before the condition: ${run.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const holdHeavy = async (name = 'H1'): Promise<{ run: Started; release: string }> => {
  const release = releaseFileOf(name);
  const run = wrapper(['heavy', '--', ...holderCommand(name, release)]);
  await until(() => lockEntries().includes('heavy.info') && eventLines().includes(`${name} start`), run);
  return { run, release };
};

const holdLight = async (name = 'L1'): Promise<{ run: Started; release: string }> => {
  const release = releaseFileOf(name);
  const before = lockEntries().filter((entry) => /^light\.[0-9a-f]{16}\.info$/.test(entry)).length;
  const run = wrapper(['light', '--', ...holderCommand(name, release)]);
  await until(() => lockEntries().filter((entry) => /^light\.[0-9a-f]{16}\.info$/.test(entry)).length > before && eventLines().includes(`${name} start`), run);
  return { run, release };
};

const quick = (marker: string): string[] => [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`];

describe.skipIf(!HAS_POSIX_SHELL)('node scripts/run-lock.ts', () => {
  it('TB21 refuses a second heavy run while the first holds the lock', async () => {
    const first = await holdHeavy();
    const second = wrapper(['heavy', '--', ...holderCommand('H2', releaseFileOf('H2'))]);

    expect(await second.exit).toBe(71);
    expect(second.stderr()).toContain(`run-lock: heavy run refused: held by heavy pid ${first.run.child.pid} started `);
    expect(second.stderr()).toContain('. To wait, pass --wait <seconds> or set MOMONGA_RUN_LOCK_WAIT_SECONDS.');
    expect(eventLines()).not.toContain('H2 start');
  });

  it('TB22 runs two light runs together', async () => {
    const first = await holdLight('L1');
    const second = await holdLight('L2');
    fs.writeFileSync(first.release, '');
    fs.writeFileSync(second.release, '');
    await first.run.exit;
    await second.run.exit;

    const lines = eventLines();
    const firstEnd = Math.min(lines.indexOf('L1 end'), lines.indexOf('L2 end'));
    expect(lines.indexOf('L1 start')).toBeLessThan(firstEnd);
    expect(lines.indexOf('L2 start')).toBeLessThan(firstEnd);
    expect(`${first.run.stderr()}${second.run.stderr()}`.split('\n').filter((line) => line.startsWith('run-lock:'))).toEqual([]);
  });

  it('TB23 refuses a heavy run beside a light one and a light run beside a heavy one', async () => {
    const light = await holdLight();
    const heavy = wrapper(['heavy', '--', ...quick(path.join(root, 'heavy-ran'))]);
    expect(await heavy.exit).toBe(71);
    expect(heavy.stderr()).toContain('light pid');
    fs.writeFileSync(light.release, '');
    await light.run.exit;

    await holdHeavy();
    const secondLight = wrapper(['light', '--', ...quick(path.join(root, 'light-ran'))]);
    expect(await secondLight.exit).toBe(71);
    expect(secondLight.stderr()).toContain('heavy pid');
  });

  it('TB24 waits with --wait 60 and starts after the holder ends', async () => {
    const first = await holdHeavy();
    const second = wrapper(['heavy', '--wait', '60', '--', ...holderCommand('H2', path.join(root, 'H2-done'))]);
    fs.writeFileSync(path.join(root, 'H2-done'), '');
    await until(() => second.stderr().includes('run-lock: heavy run waits up to 60 s for heavy pid '), second);
    fs.writeFileSync(first.release, '');

    expect(await second.exit).toBe(0);
    expect(second.stderr()).toContain('run-lock: heavy run starts after waiting ');
    const lines = eventLines();
    expect(lines.indexOf('H1 end')).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf('H1 end')).toBeLessThan(lines.indexOf('H2 start'));
  });

  it('TB25 gives up after --wait 1 with exit 72 when the holder stays', async () => {
    await holdHeavy();
    const second = wrapper(['heavy', '--wait', '1', '--', ...quick(path.join(root, 'ran'))]);

    expect(await second.exit).toBe(72);
    expect(second.stderr()).toContain('run-lock: heavy run gave up after 1 s: still held by heavy pid ');
    expect(fs.existsSync(path.join(root, 'ran'))).toBe(false);
  });

  it('TB26 waits under MOMONGA_RUN_LOCK_WAIT_SECONDS, and --wait 0 wins over the variable', async () => {
    const first = await holdHeavy();
    const option = wrapper(['heavy', '--wait', '0', '--', ...quick(path.join(root, 'option-ran'))], { MOMONGA_RUN_LOCK_WAIT_SECONDS: '60' });
    expect(await option.exit).toBe(71);

    const variable = wrapper(['heavy', '--', ...quick(path.join(root, 'variable-ran'))], { MOMONGA_RUN_LOCK_WAIT_SECONDS: '60' });
    await until(() => variable.stderr().includes('run-lock: heavy run waits up to 60 s for '), variable);
    fs.writeFileSync(first.release, '');

    expect(await variable.exit).toBe(0);
    expect(fs.existsSync(path.join(root, 'variable-ran'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'option-ran'))).toBe(false);
  });

  it.each([
    [['heavy', '--wait', 'abc'], {}, 'run-lock: --wait must be a whole number of seconds, got "abc"'],
    [['heavy'], { MOMONGA_RUN_LOCK_WAIT_SECONDS: '-1' }, 'run-lock: MOMONGA_RUN_LOCK_WAIT_SECONDS must be a whole number of seconds, got "-1"'],
  ] as Array<[string[], Record<string, string>, string]>)('TB27 refuses the wait value of %j %j with exit 64', async (args, extra, text) => {
    const marker = path.join(root, 'ran');
    const run = wrapper([...args, '--', ...quick(marker)], extra);

    expect(await run.exit).toBe(64);
    expect(run.stderr()).toContain(text);
    expect(fs.existsSync(marker)).toBe(false);
    expect(lockEntries()).toEqual([]);
  });

  it('TB28 starts a waiter after its holder is killed, and a heavy run clears a killed light run', async () => {
    const holder = await holdHeavy();
    const waiter = wrapper(['heavy', '--wait', '60', '--', ...holderCommand('H2', path.join(root, 'H2-done'))]);
    fs.writeFileSync(path.join(root, 'H2-done'), '');
    await until(() => waiter.stderr().includes('run-lock: heavy run waits up to 60 s for '), waiter);
    holder.run.child.kill('SIGKILL');
    await holder.run.processGone;

    expect(await waiter.exit).toBe(0);
    expect(eventLines()).toContain('H2 start');

    const light = await holdLight();
    light.run.child.kill('SIGKILL');
    await light.run.processGone;
    const heavy = wrapper(['heavy', '--', 'true']);

    expect(await heavy.exit).toBe(0);
    expect(lockEntries().filter((entry) => entry.startsWith('light.'))).toEqual([]);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('TB29 stops a waiting wrapper on %s without running the command', async (signal, code) => {
    const holder = await holdHeavy();
    const marker = path.join(root, 'ran');
    const waiter = wrapper(['heavy', '--wait', '60', '--', ...quick(marker)]);
    await until(() => waiter.stderr().includes('run-lock: heavy run waits up to 60 s for '), waiter);
    waiter.child.kill(signal);

    expect(await waiter.exit).toBe(code);
    expect(waiter.stderr()).toContain('run-lock: stopped while waiting; the command did not run');
    expect(fs.existsSync(marker)).toBe(false);

    fs.writeFileSync(holder.release, '');
    await holder.run.exit;
    expect(await wrapper(['heavy', '--', 'true']).exit).toBe(0);
  });

  it('TB30 exits with the code of the command', async () => {
    expect(await wrapper(['heavy', '--', process.execPath, '-e', 'process.exit(7)']).exit).toBe(7);
  });

  it('TB30 exits 143 when the command kills itself with SIGTERM', async () => {
    expect(await wrapper(['heavy', '--', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"]).exit).toBe(143);
  });

  it('TB30 forwards SIGTERM to the command and exits 143', async () => {
    const ready = path.join(root, 'ready');
    const marker = path.join(root, 'got-sigterm');
    const script = [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(marker)}, ''); process.removeAllListeners('SIGTERM'); process.kill(process.pid, 'SIGTERM'); });`,
      `fs.writeFileSync(${JSON.stringify(ready)}, '');`,
      'setInterval(() => undefined, 1000);',
    ].join('\n');
    const run = wrapper(['heavy', '--', process.execPath, '-e', script]);
    await until(() => fs.existsSync(ready), run);
    run.child.kill('SIGTERM');

    expect(await run.exit).toBe(143);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('R4 a SIGTERM sent to the wrapper alone ends its command and frees the lock while a process that command started still runs', async () => {
    const pidFile = path.join(root, 'grandchild-pid');
    const signalled = path.join(root, 'grandchild-got-sigterm');
    const grandchild = path.join(root, 'grandchild.cjs');
    const command = path.join(root, 'command.sh');
    fs.writeFileSync(
      grandchild,
      [
        "const fs = require('node:fs');",
        `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(signalled)}, ''); process.exit(0); });`,
        `setInterval(() => { if (!fs.existsSync(${JSON.stringify(root)})) process.exit(0); }, 50);`,
        `fs.writeFileSync(${JSON.stringify(`${pidFile}.partial`)}, String(process.pid));`,
        `fs.renameSync(${JSON.stringify(`${pidFile}.partial`)}, ${JSON.stringify(pidFile)});`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(command, ['#!/bin/sh', `"${process.execPath}" "${grandchild}" < /dev/null > /dev/null 2>&1`, ''].join('\n'), { mode: 0o755 });
    const run = wrapper(['heavy', '--', '/bin/sh', command]);
    let grandchildPid: number | undefined;
    try {
      await until(() => fs.existsSync(pidFile) && lockEntries().includes('heavy.info'), run);
      grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
      run.child.kill('SIGTERM');

      expect(await run.exit).toBe(143);
      expect(lockEntries().filter((entry) => entry === 'heavy.info' || /^light\./.test(entry))).toEqual([]);
      expect(await wrapper(['heavy', '--', 'true']).exit).toBe(0);
      expect({ alive: isProcessAlive(grandchildPid), signalled: fs.existsSync(signalled) }).toEqual({ alive: true, signalled: false });
    } finally {
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    }
  });

  it.each(['heavy', 'light'] as const)('TB31 gives the %s command its token', async (runClass) => {
    const run = wrapper([runClass, '--', process.execPath, '-e', 'process.stdout.write(process.env.MOMONGA_RUN_LOCK ?? "")']);

    expect(await run.exit).toBe(0);
    expect(run.stdout()).toMatch(new RegExp(`^${runClass}\\.[0-9a-f]{16}$`));
  });

  const listing = (output: string): string[] => [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(require('node:fs').readdirSync(${JSON.stringify(path.join(state, 'run-lock'))}).sort()))`,
  ];

  it.each([
    ['a heavy command that runs a heavy wrapper', 'heavy', 'heavy'],
    ['a heavy command that runs a light wrapper', 'heavy', 'light'],
  ] as const)('TB32 %s runs at once and adds no lock file', async (_case, outer, inner) => {
    const output = path.join(root, 'listing');
    const run = wrapper([outer, '--', process.execPath, WRAPPER, inner, '--', ...listing(output)]);

    expect(await run.exit).toBe(0);
    const inside = JSON.parse(fs.readFileSync(output, 'utf8')) as string[];
    expect(inside.filter((entry) => entry.startsWith('light.'))).toEqual([]);
    expect(inside.filter((entry) => entry.endsWith('.info'))).toEqual(['heavy.info']);
  });

  it('TB32 a light command that runs a heavy wrapper is refused', async () => {
    const marker = path.join(root, 'ran');
    const run = wrapper(['light', '--', process.execPath, WRAPPER, 'heavy', '--', ...quick(marker)]);

    expect(await run.exit).toBe(71);
    expect(run.stderr()).toContain('run-lock: a heavy run cannot start inside a light run');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('TB33 ignores a token whose lock is not held and acquires', async () => {
    const run = wrapper(
      ['heavy', '--', process.execPath, '-e', `process.stdout.write(JSON.parse(require('node:fs').readFileSync(${JSON.stringify(path.join(state, 'run-lock', 'heavy.info'))}, 'utf8')).token)`],
      { MOMONGA_RUN_LOCK: 'heavy.0123456789abcdef' },
    );

    expect(await run.exit).toBe(0);
    expect(run.stdout()).toMatch(/^[0-9a-f]{16}$/);
    expect(run.stdout()).not.toBe('0123456789abcdef');
  });

  it.each([
    ['no --', ['heavy', 'true']],
    ['class medium', ['medium', '--', 'true']],
    ['no command', ['heavy', '--']],
  ])('TB34 prints the usage for %s with exit 64', async (_case, args) => {
    const run = wrapper(args);

    expect(await run.exit).toBe(64);
    expect(run.stderr()).toContain(USAGE);
  });

  it('TB35 exits 73 when the state directory is under a regular file', async () => {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, '');
    const run = wrapper(['heavy', '--', 'true'], { MOMONGA_DEV_STATE_DIR: path.join(blocker, 'state') });

    expect(await run.exit).toBe(73);
    expect(run.stderr().startsWith('run-lock: cannot use ')).toBe(true);
  });

  it('TB36 exits 127 for a command that does not exist and frees the lock', async () => {
    const run = wrapper(['heavy', '--', 'no-such-command']);

    expect(await run.exit).toBe(127);
    expect(run.stderr()).toContain('run-lock: cannot start no-such-command: ');
    expect(await wrapper(['heavy', '--', 'true']).exit).toBe(0);
  });
});
