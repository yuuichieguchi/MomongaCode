import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { appendPermissionRule, systemFileLockPorts } from '@momonga/config';
import type { FileLockPorts } from '@momonga/foundation';
import { settingsLockPath } from '../src/file-lock.ts';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder, testPaths, sleepDrivenTiming, testKernelLock } from '@momonga/testkit';
import { localSettingsDir, localSettingsPath, makeDir, makeTree, registerCleanup, writeText } from './helpers.ts';
import type { Tree } from './helpers.ts';

const NEVER_ABORTED = new AbortController().signal;
const EVENT_LOOP_TURNS_BEFORE_THE_STOP = 50;

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CONFIG_ENTRY = pathToFileURL(path.resolve(import.meta.dirname, '../src/index.ts')).href;
const FOUNDATION_ENTRY = pathToFileURL(path.resolve(import.meta.dirname, '../../foundation/src/index.ts')).href;

const readLocal = (tree: Tree): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(localSettingsPath(tree), 'utf8')) as Record<string, unknown>;

describe('appendPermissionRule', () => {
  it('creates settings.local.json with 0600 in a 0700 directory', async () => {
    const tree = makeTree();
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(npm run test:*)', effect: 'allow', signal: NEVER_ABORTED });
    const dir = localSettingsDir(tree);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(localSettingsPath(tree)).mode & 0o777).toBe(0o600);
    expect(readLocal(tree)).toEqual({ permissions: { allow: ['Bash(npm run test:*)'] } });
  });

  it('appends without duplicates and preserves other content and key order', async () => {
    const tree = makeTree();
    writeText(
      localSettingsPath(tree),
      JSON.stringify({ zeta: 1, permissions: { deny: ['Read(./secret)'], allow: ['Bash(ls)'] }, alpha: { b: 2, a: 1 } }),
    );
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(ls)', effect: 'allow', signal: NEVER_ABORTED });
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Edit(./src/**)', effect: 'allow', signal: NEVER_ABORTED });
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(git push:*)', effect: 'ask', signal: NEVER_ABORTED });
    const content = readLocal(tree);
    expect(content).toEqual({
      zeta: 1,
      permissions: { deny: ['Read(./secret)'], allow: ['Bash(ls)', 'Edit(./src/**)'], ask: ['Bash(git push:*)'] },
      alpha: { b: 2, a: 1 },
    });
    expect(Object.keys(content)).toEqual(['zeta', 'permissions', 'alpha']);
    expect(Object.keys(content.permissions as object)).toEqual(['deny', 'allow', 'ask']);
    expect(Object.keys(content.alpha as object)).toEqual(['b', 'a']);
  });

  it('rejects an invalid rule without touching the file', async () => {
    const tree = makeTree();
    await expect(appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(oops', effect: 'deny', signal: NEVER_ABORTED })).rejects.toThrow('Bash(oops');
    expect(fs.existsSync(localSettingsPath(tree))).toBe(false);
  });

  it('leaves no temp files behind', async () => {
    const tree = makeTree();
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Read', effect: 'allow', signal: NEVER_ABORTED });
    expect(fs.readdirSync(localSettingsDir(tree))).toEqual(['settings.local.json']);
  });

  it('does not lose rules under concurrent in-process appends', async () => {
    const tree = makeTree();
    const rules = Array.from({ length: 20 }, (_, i) => `Bash(task${i})`);
    await Promise.all(rules.map((rule) => appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule, effect: 'allow', signal: NEVER_ABORTED })));
    const allow = (readLocal(tree).permissions as { allow: string[] }).allow;
    expect([...allow].sort()).toEqual([...rules].sort());
  });

  it('does not lose rules under concurrent appends from separate processes', async () => {
    const tree = makeTree();
    const scriptDir = makeDir();
    const script = path.join(scriptDir, 'child.mjs');
    fs.writeFileSync(
      script,
      `const { appendPermissionRule, systemFileLockPorts } = await import(process.argv[2]);
const { kernelLockNamed } = await import(${JSON.stringify(FOUNDATION_ENTRY)});
const lock = kernelLockNamed(${JSON.stringify(testKernelLock().name)});
const [projectDir, tag, home] = [process.argv[3], process.argv[4], process.argv[5]];
for (let i = 0; i < 15; i += 1) await appendPermissionRule({ lock, ports: systemFileLockPorts, home, projectDir, rule: 'Bash(' + tag + i + ')', effect: 'allow', signal: new AbortController().signal });
`,
    );
    const runChild = (tag: string): Promise<number | null> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script, CONFIG_ENTRY, tree.project, tag, tree.home], { stdio: 'ignore' });
        registerCleanup(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        });
        child.on('exit', (code) => resolve(code));
      });
    expect(await Promise.all([runChild('a'), runChild('b')])).toEqual([0, 0]);
    const allow = (readLocal(tree).permissions as { allow: string[] }).allow;
    const expected = ['a', 'b'].flatMap((tag) => Array.from({ length: 15 }, (_, i) => `Bash(${tag}${i})`));
    expect([...allow].sort()).toEqual(expected.sort());
  });

  it('keeps its lock under the account home, not beside the settings file, keyed by the comparable path of the file', async () => {
    const tree = makeTree();
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(a)', effect: 'allow', signal: NEVER_ABORTED });
    expect(fs.readdirSync(localSettingsDir(tree))).toEqual(['settings.local.json']);
    const lockPath = await settingsLockPath(tree.home, localSettingsPath(tree), testPaths());
    expect(path.dirname(lockPath)).toBe(path.join(tree.home, '.momonga', 'run'));
    expect(fs.existsSync(lockPath)).toBe(true);
    const viaLink = path.join(makeDir(), 'link');
    fs.symlinkSync(path.dirname(localSettingsPath(tree)), viaLink);
    expect(await settingsLockPath(tree.home, path.join(viaLink, 'settings.local.json'), testPaths())).toBe(lockPath);
  });

  it('times out naming the holder when another process holds the settings lock', async (context) => {
    const tree = makeTree();
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(a)', effect: 'allow', signal: NEVER_ABORTED });
    const holder = await startLockHolder(context, await settingsLockPath(tree.home, localSettingsPath(tree), testPaths()));
    await expect(appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(b)', effect: 'allow', signal: NEVER_ABORTED, lockTimeoutMs: 50 })).rejects.toThrow(
      `held by process ${holder.pid}`,
    );
    expect((readLocal(tree).permissions as { allow: string[] }).allow).toEqual(['Bash(a)']);
  });

  it('is not blocked by a lock left behind by a process that died holding it', async (context) => {
    const tree = makeTree();
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(a)', effect: 'allow', signal: NEVER_ABORTED });
    const holder = await startLockHolder(context, await settingsLockPath(tree.home, localSettingsPath(tree), testPaths()));
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(b)', effect: 'allow', signal: NEVER_ABORTED, lockTimeoutMs: 1000 });
    expect((readLocal(tree).permissions as { allow: string[] }).allow).toEqual(['Bash(a)', 'Bash(b)']);
  });

  it("a rule save waiting behind another ends with its signal's reason and writes nothing", async (context) => {
    const tree = makeTree();
    const lockPath = await settingsLockPath(tree.home, localSettingsPath(tree), testPaths());
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const holder = await startLockHolder(context, lockPath);
    const firstIsInsideItsSave = Promise.withResolvers<void>();
    const lockIsFree = Promise.withResolvers<void>();
    const heldAtTheLock: FileLockPorts = {
      timing: sleepDrivenTiming({
        now: () => 1_000_000,
        sleep: () => {
          firstIsInsideItsSave.resolve();
          return lockIsFree.promise;
        },
      }),
      random: systemFileLockPorts.random,
    };
    let secondAskedForTheLock = false;
    const neverAtTheLock: FileLockPorts = {
      ...systemFileLockPorts,
      timing: {
        ...systemFileLockPorts.timing,
        setTimeout: (callback, ms) => {
          secondAskedForTheLock = true;
          return systemFileLockPorts.timing.setTimeout(callback, ms);
        },
      },
    };
    const stop = new AbortController();
    const reason = new Error('the tool step was stopped');

    const first = appendPermissionRule({ lock: testKernelLock(), ports: heldAtTheLock, home: tree.home, projectDir: tree.project, rule: 'Bash(first)', effect: 'allow', signal: NEVER_ABORTED });
    await firstIsInsideItsSave.promise;
    const second = appendPermissionRule({ lock: testKernelLock(), ports: neverAtTheLock, home: tree.home, projectDir: tree.project, rule: 'Bash(second)', effect: 'allow', signal: stop.signal }).then(
      () => 'saved',
      (error: unknown) => error,
    );
    for (let turn = 0; turn < EVENT_LOOP_TURNS_BEFORE_THE_STOP; turn += 1) await new Promise<void>((resolve) => void setImmediate(resolve));
    stop.abort(reason);

    expect(await second).toBe(reason);
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    lockIsFree.resolve();
    await first;
    expect(secondAskedForTheLock).toBe(false);
    expect(readLocal(tree)).toEqual({ permissions: { allow: ['Bash(first)'] } });
  });
});
