import { afterEach, describe, expect, it, vi } from 'vitest';
import * as config from '@momonga/config';
import { loadSettings, loadUserSettings, resolveNetwork } from '@momonga/config';
import type { NetworkSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const NETWORK = {
  httpProxy: 'http://user:secret@proxy.corp:3128',
  httpsProxy: 'http://proxy.corp:3129',
  noProxy: '.corp.internal, 10.0.0.0/8',
  extraCaFiles: ['/etc/corp/root.pem'],
  environment: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('network setting', () => {
  it('is absent by default', async () => {
    const tree = makeTree();
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.network).toBeUndefined();
  });

  it('is read from user settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { network: NETWORK });
    const result = await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    expect(result.settings.network).toEqual(NETWORK);
    expect(result.warnings).toEqual([]);
  });

  it('accepts an unsupported proxy scheme at load, so that it is reported only on the requests that would use it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { network: { httpsProxy: 'socks5://proxy.corp:1080' } });
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.network).toEqual({ httpsProxy: 'socks5://proxy.corp:1080' });
  });

  it('rejects an unknown network property, naming the pointer', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { network: { proxy: 'http://proxy.corp:3128' } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow('/network');
  });

  it.each([
    [{ environment: 'no' }, '/network/environment'],
    [{ httpProxy: '' }, '/network/httpProxy'],
    [{ noProxy: 7 }, '/network/noProxy'],
    [{ extraCaFiles: '/etc/corp/root.pem' }, '/network/extraCaFiles'],
  ])('rejects %j, naming %s', async (network, pointer) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { network });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow(pointer);
  });

  it('rejects an extra CA file that is not an absolute path, naming the entry', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { network: { extraCaFiles: ['/etc/a.pem', 'certs/root.pem'] } });
    const failure = loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow('/network/extraCaFiles/1: not an absolute path');
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ])('discards network from %s settings with one warning, so a repository cannot redirect traffic or add a trusted CA', async (_name, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { network: { noProxy: 'user.example' } });
    const file = writeJson(locate(tree), { network: NETWORK });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.network).toEqual({ noProxy: 'user.example' });
    expect(result.warnings.filter((warning) => warning.includes(file) && warning.includes('network is only honored in user settings; discarded'))).toHaveLength(1);
  });
});

describe('network setting: empty and relative values', () => {
  it('refuses an empty noProxy at load, like an empty proxy URL', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { network: { noProxy: '' } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow('/network/noProxy');
  });

  it.each(['root.pem', './certs/root.pem', '../root.pem', '~/root.pem'])('refuses the relative extra CA file %s at load, naming the entry', async (file) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { network: { extraCaFiles: [file] } });
    await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow('/network/extraCaFiles/0: not an absolute path');
  });
});

describe('resolveNetwork', () => {
  it('has no proxy and no CA file when nothing is configured', () => {
    expect(resolveNetwork(undefined, {})).toEqual({ caFiles: [] });
  });

  it('reads nothing but the environment it is given', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://ambient.corp:1');
    vi.stubEnv('NO_PROXY', '*');
    expect(resolveNetwork(undefined, {})).toEqual({ caFiles: [] });
  });

  it.each([
    [{ https_proxy: 'http://a:1', HTTPS_PROXY: 'http://b:1' }, { value: 'http://a:1', source: 'https_proxy' }],
    [{ HTTPS_PROXY: 'http://b:1', http_proxy: 'http://c:1' }, { value: 'http://b:1', source: 'HTTPS_PROXY' }],
    [{ http_proxy: 'http://c:1', HTTP_PROXY: 'http://d:1' }, { value: 'http://c:1', source: 'http_proxy' }],
    [{ HTTP_PROXY: 'http://d:1', all_proxy: 'http://e:1' }, { value: 'http://d:1', source: 'HTTP_PROXY' }],
    [{ all_proxy: 'http://e:1', ALL_PROXY: 'http://f:1' }, { value: 'http://e:1', source: 'all_proxy' }],
    [{ ALL_PROXY: 'http://f:1' }, { value: 'http://f:1', source: 'ALL_PROXY' }],
    [{ https_proxy: '', HTTPS_PROXY: 'http://b:1' }, { value: 'http://b:1', source: 'HTTPS_PROXY' }],
  ])('takes the https proxy from %j in the order https, http, all, lower case first', (env, expected) => {
    expect(resolveNetwork(undefined, env).httpsProxy).toEqual(expected);
  });

  it.each([
    [{ http_proxy: 'http://c:1', HTTP_PROXY: 'http://d:1', HTTPS_PROXY: 'http://b:1' }, { value: 'http://c:1', source: 'http_proxy' }],
    [{ HTTP_PROXY: 'http://d:1', all_proxy: 'http://e:1' }, { value: 'http://d:1', source: 'HTTP_PROXY' }],
    [{ ALL_PROXY: 'http://f:1', HTTPS_PROXY: 'http://b:1' }, { value: 'http://f:1', source: 'ALL_PROXY' }],
    [{ HTTPS_PROXY: 'http://b:1' }, undefined],
  ])('takes the http proxy from %j in the order http, all, never the https variables', (env, expected) => {
    expect(resolveNetwork(undefined, env).httpProxy).toEqual(expected);
  });

  it('ignores names outside the standard spellings', () => {
    expect(resolveNetwork(undefined, { Https_Proxy: 'http://x:1', no_PROXY: '*' })).toEqual({ caFiles: [] });
  });

  it('takes noProxy from no_proxy, then NO_PROXY', () => {
    expect(resolveNetwork(undefined, { no_proxy: 'a.example', NO_PROXY: 'b.example' }).noProxy).toEqual({ value: 'a.example', source: 'no_proxy' });
    expect(resolveNetwork(undefined, { NO_PROXY: 'b.example' }).noProxy).toEqual({ value: 'b.example', source: 'NO_PROXY' });
  });

  it('lets each setting win over the environment for its scheme', () => {
    const env = { HTTPS_PROXY: 'http://env-s:1', HTTP_PROXY: 'http://env-h:1', NO_PROXY: 'env.example' };
    expect(resolveNetwork({ httpsProxy: 'http://set-s:1', httpProxy: 'http://set-h:1', noProxy: 'set.example' }, env)).toEqual({
      httpsProxy: { value: 'http://set-s:1', source: 'network.httpsProxy' },
      httpProxy: { value: 'http://set-h:1', source: 'network.httpProxy' },
      noProxy: { value: 'set.example', source: 'network.noProxy' },
      caFiles: [],
    });
  });

  it('serves https destinations from network.httpProxy before any variable when network.httpsProxy is absent', () => {
    const resolved = resolveNetwork({ httpProxy: 'http://set-h:1' }, { HTTPS_PROXY: 'http://env-s:1' });
    expect(resolved.httpsProxy).toEqual({ value: 'http://set-h:1', source: 'network.httpProxy' });
    expect(resolved.httpProxy).toEqual({ value: 'http://set-h:1', source: 'network.httpProxy' });
  });

  it('keeps reading the environment for a scheme the settings do not cover', () => {
    const resolved = resolveNetwork({ httpsProxy: 'http://set-s:1' }, { HTTP_PROXY: 'http://env-h:1', NO_PROXY: 'env.example' });
    expect(resolved.httpsProxy).toEqual({ value: 'http://set-s:1', source: 'network.httpsProxy' });
    expect(resolved.httpProxy).toEqual({ value: 'http://env-h:1', source: 'HTTP_PROXY' });
    expect(resolved.noProxy).toEqual({ value: 'env.example', source: 'NO_PROXY' });
  });

  it('adds the configured CA files and SSL_CERT_FILE, in that order', () => {
    expect(resolveNetwork({ extraCaFiles: ['/etc/a.pem', '/etc/b.pem'] }, { SSL_CERT_FILE: '/etc/ssl/c.pem' }).caFiles).toEqual([
      { value: '/etc/a.pem', source: 'network.extraCaFiles' },
      { value: '/etc/b.pem', source: 'network.extraCaFiles' },
      { value: '/etc/ssl/c.pem', source: 'SSL_CERT_FILE' },
    ]);
    expect(resolveNetwork(undefined, { SSL_CERT_FILE: '' }).caFiles).toEqual([]);
  });

  it('ignores every variable when network.environment is false', () => {
    const env = { HTTPS_PROXY: 'http://b:1', HTTP_PROXY: 'http://d:1', ALL_PROXY: 'http://f:1', NO_PROXY: '*', SSL_CERT_FILE: '/etc/ssl/c.pem' };
    expect(resolveNetwork({ environment: false }, env)).toEqual({ caFiles: [] });
    expect(resolveNetwork({ environment: false, httpProxy: 'http://set-h:1', extraCaFiles: ['/etc/a.pem'] }, env)).toEqual({
      httpProxy: { value: 'http://set-h:1', source: 'network.httpProxy' },
      httpsProxy: { value: 'http://set-h:1', source: 'network.httpProxy' },
      caFiles: [{ value: '/etc/a.pem', source: 'network.extraCaFiles' }],
    });
  });

  it('reads the environment when network.environment is true or absent', () => {
    const env = { HTTPS_PROXY: 'http://b:1' };
    const settings: NetworkSettings = { environment: true };
    expect(resolveNetwork(settings, env).httpsProxy).toEqual({ value: 'http://b:1', source: 'HTTPS_PROXY' });
    expect(resolveNetwork({}, env).httpsProxy).toEqual({ value: 'http://b:1', source: 'HTTPS_PROXY' });
  });
});

describe('resolveNetworkSources', () => {
  const sourcesOf = (settings: NetworkSettings | undefined, env: Record<string, string>): unknown =>
    (config as unknown as { resolveNetworkSources(settings: NetworkSettings | undefined, env: Record<string, string>): unknown }).resolveNetworkSources(settings, env);

  it('names the setting when a setting overrides a variable', () => {
    expect(sourcesOf({ httpsProxy: 'http://proxy.corp:3129', noProxy: '.corp' }, { HTTPS_PROXY: 'http://other:1', NO_PROXY: '*' })).toMatchObject({
      httpsProxy: { value: 'http://proxy.corp:3129', source: 'network.httpsProxy' },
      noProxy: { value: '.corp', source: 'network.noProxy' },
    });
  });

  it('names the variable when no setting is present', () => {
    expect(sourcesOf(undefined, { HTTP_PROXY: 'http://env.proxy:8080', SSL_CERT_FILE: '/etc/ssl/corp.pem' })).toEqual({
      httpProxy: { value: 'http://env.proxy:8080', source: 'HTTP_PROXY' },
      httpsProxy: { value: 'http://env.proxy:8080', source: 'HTTP_PROXY' },
      noProxy: { source: 'none' },
      trust: [{ value: '/etc/ssl/corp.pem', source: 'SSL_CERT_FILE' }],
    });
  });

  it('says none when neither a setting nor a variable is present, and when the environment is turned off', () => {
    const none = { httpProxy: { source: 'none' }, httpsProxy: { source: 'none' }, noProxy: { source: 'none' }, trust: [] };
    expect(sourcesOf(undefined, {})).toEqual(none);
    expect(sourcesOf({ environment: false }, { HTTPS_PROXY: 'http://env:1' })).toEqual(none);
  });

  it('shows a proxy URL with credentials without them', () => {
    const shown = JSON.stringify(sourcesOf(NETWORK, {}));
    expect(sourcesOf(NETWORK, {})).toMatchObject({
      httpProxy: { value: 'http://proxy.corp:3128', source: 'network.httpProxy' },
      trust: [{ value: '/etc/corp/root.pem', source: 'network.extraCaFiles' }],
    });
    expect(shown).not.toContain('secret');
    expect(shown).not.toContain('user:');
  });
});
