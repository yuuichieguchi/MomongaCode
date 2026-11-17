import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appendPermissionRule, editSettings, systemFileLockPorts, loadMcpServers, loadSettings } from '@momonga/config';
import { distrusting, localSettingsPath, makeTree, mcpJsonPath, projectSettingsPath, userSettingsPath, writeJson } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const NEVER_ABORTED = new AbortController().signal;

describe('local settings in an untrusted project', () => {
  it('applies an allow_always rule written by appendPermissionRule', async () => {
    const tree = makeTree();
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(npm run test:*)', effect: 'allow', signal: NEVER_ABORTED });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(result.rules.map((r) => [r.text, r.effect, r.origin, r.source])).toEqual([
      ['Bash(npm run test:*)', 'allow', 'local', localSettingsPath(tree)],
    ]);
    expect(result.files).toEqual([localSettingsPath(tree)]);
    expect(result.warnings).toEqual([]);
  });

  it('applies a reject_always rule written by appendPermissionRule', async () => {
    const tree = makeTree();
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(rm:*)', effect: 'deny', signal: NEVER_ABORTED });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(result.rules.map((r) => [r.text, r.effect, r.origin])).toEqual([['Bash(rm:*)', 'deny', 'local']]);
  });

  it('still skips project settings and names only the project file', async () => {
    const tree = makeTree();
    const project = writeJson(projectSettingsPath(tree), { permissions: { allow: ['Bash(curl:*)'] } });
    const local = writeJson(localSettingsPath(tree), { permissions: { allow: ['Bash(wget:*)'] } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(result.rules.map((r) => r.text)).toEqual(['Bash(wget:*)']);
    expect(result.files).toEqual([local]);
    const warning = result.warnings.find((w) => /not trusted/i.test(w));
    expect(warning).toContain(project);
    expect(warning).not.toContain(local);
  });

  it('keeps .mcp.json unread even when local settings approve its servers', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {});
    writeJson(localSettingsPath(tree), { enableAllProjectMcpServers: true });
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { evil: { command: 'evil' } } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: distrusting(), env: {}, referenceEnv: {} });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.some((w) => w.includes(file))).toBe(true);
  });
});

describe('an edit of a key that the local file shadows', () => {
  const FILE_OPTIONS = { env: process.env, lock: testKernelLock(), signal: NEVER_ABORTED };

  it('writes the user file and names the local file that shadows the key in an untrusted folder', async () => {
    const tree = makeTree();
    const user = writeJson(userSettingsPath(tree), { context: { loopGuidance: true } });
    const local = writeJson(localSettingsPath(tree), { context: { loopGuidance: false } });
    const result = await editSettings({ home: tree.home, projectDir: tree.project }, 'user', { kind: 'set', path: ['context', 'loopGuidance'], value: true }, { ...FILE_OPTIONS, trusted: false });
    expect(JSON.parse(fs.readFileSync(user, 'utf8'))).toEqual({ context: { loopGuidance: true } });
    expect(result.shadowedBy).toEqual({ layer: 'local', file: local });
  });

  it('reports no shadow when the local file does not set the key', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { loopGuidance: true } });
    writeJson(localSettingsPath(tree), { context: { cachePrefix: true } });
    const result = await editSettings({ home: tree.home, projectDir: tree.project }, 'user', { kind: 'set', path: ['context', 'loopGuidance'], value: false }, { ...FILE_OPTIONS, trusted: false });
    expect(result.shadowedBy).toBeUndefined();
  });

  it('does not name a project file that an untrusted folder does not apply', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { context: { loopGuidance: true } });
    writeJson(projectSettingsPath(tree), { context: { loopGuidance: false } });
    const result = await editSettings({ home: tree.home, projectDir: tree.project }, 'user', { kind: 'set', path: ['context', 'loopGuidance'], value: true }, { ...FILE_OPTIONS, trusted: false });
    expect(result.shadowedBy).toBeUndefined();
  });
});
