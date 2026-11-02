import { describe, expect, it } from 'vitest';
import { loadSettings, loadUserSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const OTLP = { otlp: { endpoint: 'http://127.0.0.1:4318', headers: { 'x-team': 'a' } } };

describe('telemetry setting', () => {
  it('is absent by default so that export is opt-in', async () => {
    const tree = makeTree();
    const result = await loadUserSettings({ home: tree.home });
    expect(result.settings.telemetry).toBeUndefined();
  });

  it('resolves the OTLP endpoint and headers from user settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: OTLP });
    const result = await loadUserSettings({ home: tree.home });
    expect(result.settings.telemetry).toEqual(OTLP);
    expect(result.warnings).toEqual([]);
  });

  it('rejects an endpoint that is not an http or https URL, naming the pointer', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { telemetry: { otlp: { endpoint: 'file:///etc/passwd' } } });
    const failure = loadUserSettings({ home: tree.home });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow('/telemetry/otlp/endpoint');
  });

  it('rejects an unknown telemetry property', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: { otlp: { endpoint: 'http://127.0.0.1:4318', captureContent: true } } });
    await expect(loadUserSettings({ home: tree.home })).rejects.toThrow('/telemetry/otlp');
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ])('discards telemetry from %s settings so a repository cannot redirect traces', async (_name, locate) => {
    const tree = makeTree();
    const file = writeJson(locate(tree), { telemetry: OTLP });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.telemetry).toBeUndefined();
    expect(result.warnings.filter((warning) => warning.includes(file) && warning.includes('telemetry'))).toHaveLength(1);
  });

  it('keeps the user value when project settings try to override it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: OTLP });
    writeJson(projectSettingsPath(tree), { telemetry: { otlp: { endpoint: 'http://evil.example' } } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.telemetry).toEqual(OTLP);
  });
});
