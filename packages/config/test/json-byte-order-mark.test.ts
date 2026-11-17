import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_MANDATE_FILE, approvalDigestOf, loadMcpServers, loadProjectMandate, loadSettings, readAutoFitView, writeAutoFitRecord } from '@momonga/config';
import type { AutoFitKey, AutoFitRecord } from '@momonga/config';
import { makeDir, makeTree, mcpJsonPath, trusting, userSettingsPath, writeText } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const BYTE_ORDER_MARK = '﻿';

const marked = (value: unknown): string => `${BYTE_ORDER_MARK}${JSON.stringify(value, null, 2)}`;

const signal = new AbortController().signal;

describe('a JSON file that begins with a byte order mark', () => {
  it('loads as a settings file with its values', async () => {
    const tree = makeTree();
    writeText(userSettingsPath(tree), marked({ autoUpdates: false, permissions: { deny: ['Read(.env)'] } }));
    const result = await loadSettings({ env: process.env, signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.autoUpdates).toBe(false);
    expect(result.rules.map((rule) => rule.text)).toEqual(['Read(.env)']);
    expect(result.warnings).toEqual([]);
  });

  it('loads as a project .mcp.json with its servers', async () => {
    const tree = makeTree();
    writeText(userSettingsPath(tree), JSON.stringify({ enableAllProjectMcpServers: true }));
    writeText(mcpJsonPath(tree), marked({ mcpServers: { docs: { command: 'docs-server' } } }));
    const result = await loadMcpServers({ signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, referenceEnv: {} });
    expect(result.failed).toEqual([]);
    expect(result.enabled.map((entry) => entry.name)).toEqual(['docs']);
  });

  it('loads as a project mandate file with its values', async () => {
    const tree = makeTree();
    writeText(path.join(tree.project, PROJECT_MANDATE_FILE), marked({ deny: ['Bash(curl:*)'], steps: 20 }));
    expect(await loadProjectMandate({ signal, projectDir: tree.project, trusted: true, approvals: { [tree.project]: { mandate: approvalDigestOf({ deny: ['Bash(curl:*)'], steps: 20 }) } } })).toEqual({ deny: ['Bash(curl:*)'], steps: 20 });
  });

  it('loads as an auto mode measurement record', async () => {
    const directory = makeDir();
    const key: AutoFitKey = { classifier: 'endpoint identity', codeDigest: 'c'.repeat(64), datasetDigest: 'd'.repeat(64) };
    const record = {
      key,
      cases: [{ id: 'case-1', meetsMinimum: true }],
      falseAllow: { successes: 0, trials: 75, high: 0.0487 },
      falseBlock: { successes: 1, trials: 75, high: 0.0718 },
      runs: 150,
      unobserved: 2,
      recordedAt: '2026-11-10T00:00:00.000Z',
      version: '0.0.0',
      agentModel: 'ollama/devstral-small-2:latest',
    } as unknown as AutoFitRecord;
    const file = await writeAutoFitRecord(directory, record, (bytes) => 'ab'.repeat(bytes), testKernelLock());
    fs.writeFileSync(file, marked(record), { mode: 0o600 });
    expect(await readAutoFitView(directory, 'guard', key)).toMatchObject({ measurement: expect.stringMatching(/^(passed|did_not_pass)$/u), facts: { recordedAt: record.recordedAt } });
  });

  it('keeps a byte order mark inside a string, and removes only the one at the start', async () => {
    const tree = makeTree();
    writeText(userSettingsPath(tree), marked({ env: { GREETING: `${BYTE_ORDER_MARK}hello${BYTE_ORDER_MARK}` } }));
    const result = await loadSettings({ env: process.env, signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.env).toEqual({ GREETING: `${BYTE_ORDER_MARK}hello${BYTE_ORDER_MARK}` });
  });

  it('refuses a second byte order mark as invalid JSON at line 1 column 1', async () => {
    const tree = makeTree();
    const file = writeText(userSettingsPath(tree), `${BYTE_ORDER_MARK}${marked({ autoUpdates: false })}`);
    await expect(loadSettings({ env: process.env, signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toThrow(`${file}: invalid JSON at line 1 column 1`);
  });
});
