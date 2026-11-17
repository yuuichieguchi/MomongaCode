import { describe, expect, it } from 'vitest';
import { loadSettings, loadUserSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const OTLP = { otlp: { endpoint: 'http://127.0.0.1:4318', headers: { 'x-team': 'a' } } };

describe('telemetry setting', () => {
  it('is absent by default so that export is opt-in', async () => {
    const tree = makeTree();
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.settings.telemetry).toBeUndefined();
  });

  it('resolves the OTLP endpoint and headers from user settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: OTLP });
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.settings.telemetry).toEqual(OTLP);
    expect(result.warnings).toEqual([]);
  });

  it('rejects an endpoint that is not an http or https URL, naming the pointer', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { telemetry: { otlp: { endpoint: 'file:///etc/passwd' } } });
    const failure = loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow('/telemetry/otlp/endpoint');
  });

  it('turns message content capture on only when the user sets captureMessageContent', async () => {
    const tree = makeTree();
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.telemetry).toBeUndefined();
    writeJson(userSettingsPath(tree), { telemetry: { ...OTLP, captureMessageContent: true } });
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.settings.telemetry).toEqual({ ...OTLP, captureMessageContent: true });
    expect(result.warnings).toEqual([]);
  });

  it('rejects a captureMessageContent that is not a boolean', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: { captureMessageContent: 'yes' } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow('/telemetry/captureMessageContent');
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ])('discards captureMessageContent from %s settings so a repository cannot turn capture on', async (_name, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: OTLP });
    writeJson(locate(tree), { telemetry: { captureMessageContent: true } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.telemetry).toEqual(OTLP);
  });

  it('rejects an unknown telemetry property', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: { otlp: { endpoint: 'http://127.0.0.1:4318', captureContent: true } } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow('/telemetry/otlp');
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ])('discards telemetry from %s settings so a repository cannot redirect traces', async (_name, locate) => {
    const tree = makeTree();
    const file = writeJson(locate(tree), { telemetry: OTLP });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.telemetry).toBeUndefined();
    expect(result.warnings.filter((warning) => warning.includes(file) && warning.includes('telemetry'))).toHaveLength(1);
  });

  it('keeps the user value when project settings try to override it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { telemetry: OTLP });
    writeJson(projectSettingsPath(tree), { telemetry: { otlp: { endpoint: 'https://evil.example' } } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.telemetry).toEqual(OTLP);
  });
});
