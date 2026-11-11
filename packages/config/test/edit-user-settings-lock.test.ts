import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, PROJECT_MANDATE_FILE, appendPermissionRule, editProjectMandate, editUserSettings, settingsFileLock, systemFileLockPorts } from '@momonga/config';
import type { SettingsLockPort } from '@momonga/config';
import { LockWaitTimeoutError, momongaLayout } from '@momonga/foundation';
import { DEFAULT_LOCK_TIMEOUT_MS } from '../../foundation/src/file-lock.ts';
import { REAL_PROCESS_TEST_TIMEOUT_MS, sleepDrivenTiming, startLockHolder, testPaths, testKernelLock } from '@momonga/testkit';
import { settingsLockPath } from '../src/file-lock.ts';
import { localSettingsPath, makeDir, makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const APPEND_RULE_SOURCE = path.resolve(import.meta.dirname, '../src/append-rule.ts');
const ORIGINAL = { models: { connections: [] } };

const userSettingsOf = (tree: Tree): string => writeJson(momongaLayout(tree.home, process.platform, process.env).settingsFile, ORIGINAL);

const lockRunDirectoryOf = (tree: Tree): void => {
  fs.mkdirSync(momongaLayout(tree.home, process.platform, process.env).run, { recursive: true, mode: 0o700 });
};

const { random } = systemFileLockPorts;

const heldOut = (tree: Tree) => ({ mechanism: testKernelLock(), lock: settingsFileLock(tree.home, { lock: testKernelLock(), lockTimeoutMs: 50 }), random, signal: new AbortController().signal });

const countingLock = () => {
  const events: string[] = [];
  const signals: AbortSignal[] = [];
  const lock: SettingsLockPort = {
    locked: async (file, signal, work) => {
      events.push(`acquire ${file}`);
      signals.push(signal);
      try {
        return await work();
      } finally {
        events.push(`release ${file}`);
      }
    },
  };
  return { events, signals, lock };
};

const recordingEdit = () => {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    edit: (document: Record<string, unknown>): boolean => {
      calls.push(document);
      document['network'] = { httpsProxy: 'http://proxy.corp:3128' };
      return true;
    },
  };
};

describe('editUserSettings is the one writer of a settings file and takes the settings lock under the home', () => {
  it('takes the lock at settingsLockPath(home, file)', async (context) => {
    const tree = makeTree();
    const file = userSettingsOf(tree);
    lockRunDirectoryOf(tree);
    const holder = await startLockHolder(context, await settingsLockPath(tree.home, file, testPaths()));
    const recorded = recordingEdit();
    await expect(editUserSettings(file, recorded.edit, heldOut(tree))).rejects.toThrow(`held by process ${holder.pid}`);
    expect(recorded.calls).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(ORIGINAL);
  });

  it('a held lock with a lock timeout rejects with LockWaitTimeoutError and leaves the file as it was (A5, R9)', async (context) => {
    const tree = makeTree();
    const file = userSettingsOf(tree);
    lockRunDirectoryOf(tree);
    await startLockHolder(context, await settingsLockPath(tree.home, file, testPaths()));
    const recorded = recordingEdit();
    await expect(editUserSettings(file, recorded.edit, heldOut(tree))).rejects.toBeInstanceOf(LockWaitTimeoutError);
    expect(recorded.calls).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(ORIGINAL);
  });

  it('with no lock timeout the wait has no fixed 10 s: it lasts until the operation\'s signal ends it, with that signal\'s reason', async (context) => {
    const tree = makeTree();
    const file = userSettingsOf(tree);
    lockRunDirectoryOf(tree);
    await startLockHolder(context, await settingsLockPath(tree.home, file, testPaths()));
    const operation = new AbortController();
    const reason = new Error('the operation limit ended');
    let now = 1_000_000;
    const started = now;
    const ports = {
      random,
      timing: sleepDrivenTiming({
        now: () => now,
        sleep: async (ms: number): Promise<void> => {
          now += ms;
          if (now - started > 3 * DEFAULT_LOCK_TIMEOUT_MS) operation.abort(reason);
        },
      }),
    };
    const recorded = recordingEdit();
    await expect(editUserSettings(file, recorded.edit, { mechanism: testKernelLock(), lock: settingsFileLock(tree.home, { lock: testKernelLock(), ports }), random, signal: operation.signal })).rejects.toBe(reason);
    expect(now - started).toBeGreaterThan(3 * DEFAULT_LOCK_TIMEOUT_MS);
    expect(recorded.calls).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(ORIGINAL);
  });

  it('a symlink spelling of the file takes the same lock', async (context) => {
    const tree = makeTree();
    const realFile = userSettingsOf(tree);
    lockRunDirectoryOf(tree);
    const viaLink = path.join(makeDir(), 'link');
    fs.symlinkSync(path.dirname(realFile), viaLink);
    const linkPath = path.join(viaLink, path.basename(realFile));
    const holder = await startLockHolder(context, await settingsLockPath(tree.home, realFile, testPaths()));
    const recorded = recordingEdit();
    await expect(editUserSettings(linkPath, recorded.edit, heldOut(tree))).rejects.toThrow(`held by process ${holder.pid}`);
    expect(recorded.calls).toEqual([]);
  });

  it('creates no lock file beside the settings file', async () => {
    const tree = makeTree();
    const file = userSettingsOf(tree);
    await editUserSettings(file, recordingEdit().edit, { mechanism: testKernelLock(), lock: settingsFileLock(tree.home, { lock: testKernelLock() }), random, signal: new AbortController().signal });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.lock'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...ORIGINAL, network: { httpsProxy: 'http://proxy.corp:3128' } });
  });

  it('appendPermissionRule and editUserSettings take the same lock for one local settings file', async (context) => {
    const tree = makeTree();
    await appendPermissionRule({ lock: testKernelLock(), signal: new AbortController().signal, ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(a)', effect: 'allow' });
    const holder = await startLockHolder(context, await settingsLockPath(tree.home, localSettingsPath(tree), testPaths()));
    await expect(appendPermissionRule({ lock: testKernelLock(), signal: new AbortController().signal, ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(b)', effect: 'allow', lockTimeoutMs: 50 })).rejects.toThrow(
      `held by process ${holder.pid}`,
    );
    const recorded = recordingEdit();
    await expect(editUserSettings(localSettingsPath(tree), recorded.edit, heldOut(tree))).rejects.toThrow(`held by process ${holder.pid}`);
    expect(recorded.calls).toEqual([]);
  });

  it('append-rule.ts has no writer of its own', () => {
    const source = fs.readFileSync(APPEND_RULE_SOURCE, 'utf8');
    expect(['writeFileAtomically', 'readJsonFile', 'withFileLock', 'createKeyedSerializer'].filter((name) => source.includes(name))).toEqual([]);
  });
});

describe('the settings writers take the lock through the lock port they are given', () => {
  it('one edit acquires the lock of the file once under the signal of the asker, runs the edit once inside it and releases it', async () => {
    const tree = makeTree();
    const file = userSettingsOf(tree);
    const counted = countingLock();
    const asker = new AbortController();
    let edits = 0;
    await editUserSettings(
      file,
      (document) => {
        edits += 1;
        counted.events.push('edit');
        document['autoUpdates'] = false;
        return true;
      },
      { mechanism: testKernelLock(), lock: counted.lock, random, signal: asker.signal },
    );
    expect(counted.events).toEqual([`acquire ${file}`, 'edit', `release ${file}`]);
    expect(counted.signals).toEqual([asker.signal]);
    expect(edits).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...ORIGINAL, autoUpdates: false });
    expect(fs.existsSync(momongaLayout(tree.home, process.platform, process.env).run)).toBe(false);
  });

  it('releases the lock when the edit refuses, and writes nothing', async () => {
    const tree = makeTree();
    const file = userSettingsOf(tree);
    const counted = countingLock();
    const refusal = new ConfigError('refused by the validator');
    await expect(
      editUserSettings(
        file,
        () => {
          throw refusal;
        },
        { mechanism: testKernelLock(), lock: counted.lock, random, signal: new AbortController().signal },
      ),
    ).rejects.toBe(refusal);
    expect(counted.events).toEqual([`acquire ${file}`, `release ${file}`]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(ORIGINAL);
  });

  it('locks the file a link names', async () => {
    const tree = makeTree();
    const target = userSettingsOf(tree);
    const link = path.join(makeDir(), 'settings.json');
    fs.symlinkSync(target, link);
    const counted = countingLock();
    await editUserSettings(link, recordingEdit().edit, { mechanism: testKernelLock(), lock: counted.lock, random, signal: new AbortController().signal });
    expect(counted.events).toEqual([`acquire ${target}`, `release ${target}`]);
  });

  it('the writer of the project mandate file acquires once, runs the edit once and validates the result before it releases', async () => {
    const tree = makeTree();
    const file = path.join(tree.project, PROJECT_MANDATE_FILE);
    const counted = countingLock();
    let edits = 0;
    const options = { home: tree.home, trust: trusting(tree), mechanism: testKernelLock(), lock: counted.lock, random, signal: new AbortController().signal };
    await editProjectMandate(
      tree.project,
      (document) => {
        edits += 1;
        document['steps'] = 20;
        return true;
      },
      options,
    );
    const userFile = userSettingsPath(tree);
    expect(counted.events).toEqual([`acquire ${file}`, `release ${file}`, `acquire ${userFile}`, `release ${userFile}`]);
    expect(edits).toBe(1);
    const refused = editProjectMandate(
      tree.project,
      (document) => {
        edits += 1;
        document['steps'] = 0;
        return true;
      },
      options,
    );
    await expect(refused).rejects.toThrow(`${file}: /steps must be >= 1`);
    expect(counted.events).toEqual([`acquire ${file}`, `release ${file}`, `acquire ${userFile}`, `release ${userFile}`, `acquire ${file}`, `release ${file}`]);
    expect(edits).toBe(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ steps: 20 });
  });

  it('a folder that is not trusted is refused before the lock is asked for', async () => {
    const tree = makeTree();
    const counted = countingLock();
    await expect(editProjectMandate(tree.project, () => true, { home: tree.home, mechanism: testKernelLock(), trust: { isTrusted: () => false }, lock: counted.lock, random, signal: new AbortController().signal })).rejects.toBeInstanceOf(ConfigError);
    expect(counted.events).toEqual([]);
  });
});
