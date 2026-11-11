import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_DAYS, loadSettings, loadUserSettings, resolveRetentionSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const signal = new AbortController().signal;

describe('retention.days', () => {
  it('defaults to 30 days', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(resolveRetentionSettings(undefined)).toEqual({ days: 30 });
    expect(resolveRetentionSettings({})).toEqual({ days: 30 });
  });

  it.each([1, 7, 36500])('takes the user value %j', async (days) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { retention: { days } });
    const result = await loadUserSettings({ home: tree.home, signal });
    expect(result.warnings).toEqual([]);
    expect(resolveRetentionSettings(result.settings.retention)).toEqual({ days });
  });

  it.each([0, 36501, -1, 1.5, '30'])('refuses %j, naming the pointer and the bounds', async (days) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { retention: { days } });
    const refusal = loadUserSettings({ home: tree.home, signal });
    await expect(refusal).rejects.toThrow('/retention/days');
  });

  it.each([0, 36501])('names the bound %j breaks', async (days) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { retention: { days } });
    await expect(loadUserSettings({ home: tree.home, signal })).rejects.toThrow(days === 0 ? /1/ : /36500/);
  });

  it('discards a project value with a warning and keeps the user value', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { retention: { days: 9 } });
    writeJson(projectSettingsPath(tree), { retention: { days: 2 } });
    const result = await loadSettings({ signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.warnings).toEqual([`${projectSettingsPath(tree)}: retention is only honored in user settings; discarded`]);
    expect(resolveRetentionSettings(result.settings.retention)).toEqual({ days: 9 });
  });

  it('refuses the retired telemetry.contentRetentionDays and names retention.days', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: { contentRetentionDays: 7 } });
    await expect(loadUserSettings({ home: tree.home, signal })).rejects.toThrow(/telemetry\.contentRetentionDays.*retention\.days/);
  });
});
