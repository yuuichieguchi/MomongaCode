import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalDigestOf, loadMcpServers, loadProjectMandate, loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

describe('the settings of a project are loaded under the signal of the asker', () => {
  it('ends with the reason of the asker when its signal has aborted, not with a settings error', async () => {
    const tree = makeTree();
    const extra = path.join(tree.home, 'extra');
    fs.mkdirSync(extra);
    writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: ['./extra'] } });
    const reason = new Error('the request ended');
    await expect(loadSettings({ signal: AbortSignal.abort(reason), home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toBe(reason);
  });

  it('hands the signal of the asker to the trust decision', async () => {
    const tree = makeTree();
    const signal = new AbortController().signal;
    const asked: AbortSignal[] = [];
    const trust = {
      isTrusted: (_directory: string, given: AbortSignal): boolean => {
        asked.push(given);
        return false;
      },
    };
    await loadSettings({ signal, home: tree.home, projectDir: tree.project, cli: {}, trust });
    await loadMcpServers({ signal, home: tree.home, projectDir: tree.project, trust, env: {}, referenceEnv: {} });
    expect(asked).toEqual([signal, signal, signal]);
  });

  it('resolves the link of a project settings file under the signal of the asker', async () => {
    const tree = makeTree();
    const directory = path.join(tree.project, '.momonga');
    fs.mkdirSync(directory);
    writeJson(path.join(tree.project, 'real-settings.json'), {});
    fs.symlinkSync(path.join(tree.project, 'real-settings.json'), path.join(directory, 'settings.json'));
    writeJson(path.join(tree.project, 'real-mandate.json'), {});
    fs.symlinkSync(path.join(tree.project, 'real-mandate.json'), path.join(directory, 'mandate.json'));
    const reason = new Error('the request ended');
    await expect(loadProjectMandate({ projectDir: tree.project, trusted: true, approvals: undefined, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await expect(loadProjectMandate({ projectDir: tree.project, trusted: true, approvals: { [tree.project]: { mandate: approvalDigestOf({}) } }, signal: new AbortController().signal })).resolves.toEqual({});
  });
});
