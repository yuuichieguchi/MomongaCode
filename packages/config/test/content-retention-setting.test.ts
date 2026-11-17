import { describe, expect, it } from 'vitest';
import { loadUserSettings, resolveTelemetrySettings } from '@momonga/config';
import { makeTree, userSettingsPath, writeJson } from './helpers.ts';

describe('telemetry content capture', () => {
  it('is off by default and carries no retention of its own', () => {
    expect(resolveTelemetrySettings(undefined)).toEqual({ captureMessageContent: false });
    expect(resolveTelemetrySettings({ captureMessageContent: true })).toEqual({ captureMessageContent: true });
  });

  it('takes the user value', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: { captureMessageContent: true } });
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.warnings).toEqual([]);
    expect(resolveTelemetrySettings(result.settings.telemetry)).toEqual({ captureMessageContent: true });
  });

  it.each([1, 30])('does not load a file that sets telemetry.contentRetentionDays %j, and names retention.days', async (value) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: { captureMessageContent: true, contentRetentionDays: value } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow('retention.days');
  });
});
