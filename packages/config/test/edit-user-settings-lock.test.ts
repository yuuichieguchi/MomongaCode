import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appendPermissionRule, editUserSettings, systemFileLockPorts } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder } from '@momonga/testkit';
import { settingsLockPath } from '../src/file-lock.ts';
import { localSettingsPath, makeDir, makeTree, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const APPEND_RULE_SOURCE = path.resolve(import.meta.dirname, '../src/append-rule.ts');
const ORIGINAL = { models: { aliases: {}, targets: {} } };

const userSettingsOf = (tree: Tree): string => writeJson(momongaLayout(tree.home).settingsFile, ORIGINAL);

const lockRunDirectoryOf = (tree: Tree): void => {
  fs.mkdirSync(momongaLayout(tree.home).run, { recursive: true, mode: 0o700 });
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
    const holder = await startLockHolder(context, settingsLockPath(tree.home, file));
    const recorded = recordingEdit();
    await expect(editUserSettings(tree.home, file, recorded.edit, { signal: new AbortController().signal, lockTimeoutMs: 50 })).rejects.toThrow(`held by process ${holder.pid}`);
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
    const holder = await startLockHolder(context, settingsLockPath(tree.home, realFile));
    const recorded = recordingEdit();
    await expect(editUserSettings(tree.home, linkPath, recorded.edit, { signal: new AbortController().signal, lockTimeoutMs: 50 })).rejects.toThrow(`held by process ${holder.pid}`);
    expect(recorded.calls).toEqual([]);
  });

  it('creates no lock file beside the settings file', async () => {
    const tree = makeTree();
    const file = userSettingsOf(tree);
    await editUserSettings(tree.home, file, recordingEdit().edit, { signal: new AbortController().signal });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.lock'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ...ORIGINAL, network: { httpsProxy: 'http://proxy.corp:3128' } });
  });

  it('appendPermissionRule and editUserSettings take the same lock for one local settings file', async (context) => {
    const tree = makeTree();
    await appendPermissionRule({ signal: new AbortController().signal, ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(a)', effect: 'allow' });
    const holder = await startLockHolder(context, settingsLockPath(tree.home, localSettingsPath(tree)));
    await expect(appendPermissionRule({ signal: new AbortController().signal, ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(b)', effect: 'allow', lockTimeoutMs: 50 })).rejects.toThrow(
      `held by process ${holder.pid}`,
    );
    const recorded = recordingEdit();
    await expect(editUserSettings(tree.home, localSettingsPath(tree), recorded.edit, { signal: new AbortController().signal, lockTimeoutMs: 50 })).rejects.toThrow(`held by process ${holder.pid}`);
    expect(recorded.calls).toEqual([]);
  });

  it('append-rule.ts has no writer of its own', () => {
    const source = fs.readFileSync(APPEND_RULE_SOURCE, 'utf8');
    expect(['writeFileAtomically', 'readJsonFile', 'withFileLock', 'createKeyedSerializer'].filter((name) => source.includes(name))).toEqual([]);
  });
});
