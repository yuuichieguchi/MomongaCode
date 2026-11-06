import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT_RETENTION_DAYS, loadUserSettings, resolveTelemetrySettings } from '@momonga/config';
import { makeTree, userSettingsPath, writeJson } from './helpers.ts';

describe('telemetry.contentRetentionDays', () => {
  it('defaults to 30 days', () => {
    expect(DEFAULT_CONTENT_RETENTION_DAYS).toBe(30);
    expect(resolveTelemetrySettings(undefined)).toEqual({ captureMessageContent: false, contentRetentionDays: 30 });
    expect(resolveTelemetrySettings({ captureMessageContent: true })).toEqual({ captureMessageContent: true, contentRetentionDays: 30 });
  });

  it('takes the user value', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: { captureMessageContent: true, contentRetentionDays: 7 } });
    const result = await loadUserSettings({ home: tree.home });
    expect(result.settings.telemetry).toEqual({ captureMessageContent: true, contentRetentionDays: 7 });
    expect(result.warnings).toEqual([]);
    expect(resolveTelemetrySettings(result.settings.telemetry)).toEqual({ captureMessageContent: true, contentRetentionDays: 7 });
  });

  it.each([0, -1, 1.5, '30'])('accepts a positive integer and rejects %j, naming the pointer', async (value) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: { contentRetentionDays: 1 } });
    expect((await loadUserSettings({ home: tree.home })).settings.telemetry).toEqual({ contentRetentionDays: 1 });
    writeJson(userSettingsPath(tree), { telemetry: { contentRetentionDays: value } });
    await expect(loadUserSettings({ home: tree.home })).rejects.toThrow('/telemetry/contentRetentionDays');
  });
});
