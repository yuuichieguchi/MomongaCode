import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PATH_VALUED_HTTP_KEYS, trustConfigOf } from '../../src/operations/argv.ts';
import { appendGitConfig } from '../../src/read-only-call.ts';

const CONFIGURATION_ERROR = /Unsupported SSL backend|bad config|unable to parse|is not a valid|fatal: unknown/i;

describe('the credential step gives git no path-valued http key of the repository', () => {
  it.each(PATH_VALUED_HTTP_KEYS)('neutralises %s', (key) => {
    expect(trustConfigOf('/session/ca.pem')).toContainEqual([key, '']);
  });

  it('keeps the bundle of trusted certificates as the CA file', () => {
    expect(trustConfigOf('/session/ca.pem')).toContainEqual(['http.sslCAInfo', '/session/ca.pem']);
  });

  it('names every http key the git manual gives a file or directory, so none is left to a repository setting', () => {
    expect(PATH_VALUED_HTTP_KEYS).toEqual(
      expect.arrayContaining(['http.sslCert', 'http.sslKey', 'http.sslCAPath', 'http.pinnedPubkey', 'http.proxySSLCert', 'http.proxySSLKey', 'http.proxySSLCAInfo']),
    );
  });

  it.each(['http.sslBackend', 'http.sslCertType', 'http.sslKeyType', 'http.sslCertPasswordProtected', 'http.proxySSLCertPasswordProtected', 'http.sslCipherList', 'http.sslVersion'])(
    'leaves %s alone, since it names no file or directory',
    (key) => {
      expect(PATH_VALUED_HTTP_KEYS).not.toContain(key);
      expect(trustConfigOf('/session/ca.pem').map(([name]) => name)).not.toContain(key);
    },
  );
});

describe('real git accepts the configuration the credential step produces', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'argv-credential-keys-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports no configuration error for an https remote, and reaches the transport', () => {
    const bundle = path.join(home, 'ca.pem');
    fs.writeFileSync(bundle, '');
    const env = appendGitConfig({ PATH: process.env['PATH'] ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, trustConfigOf(bundle));
    const result = spawnSync('git', ['ls-remote', 'https://host.invalid/owner/repo.git'], { env, encoding: 'utf8', cwd: home });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toMatch(CONFIGURATION_ERROR);
    expect(result.stderr).toMatch(/unable to access/);
  });
});
