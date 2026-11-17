import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PATH_VALUED_HTTP_KEYS, trustConfigOf } from '../../src/operations/argv.ts';
import { appendGitConfig } from '../../src/read-only-call.ts';
import { createTempDir } from '@momonga/testkit';

const CONFIGURATION_ERROR = /Unsupported SSL backend|bad config|unable to parse|is not a valid|fatal: unknown/i;

describe('the credential step gives git no path-valued http key of the repository', () => {
  it.each(PATH_VALUED_HTTP_KEYS)('neutralises %s', (key) => {
    expect(trustConfigOf('/session/ca.pem')).toContainEqual([key, '']);
  });

  it('keeps the bundle of trusted certificates as the CA file', () => {
    expect(trustConfigOf('/session/ca.pem')).toContainEqual(['http.sslCAInfo', '/session/ca.pem']);
  });

  it('neutralises the path-valued keys that git accepts with an empty value', () => {
    expect(PATH_VALUED_HTTP_KEYS).toEqual(['http.sslKey', 'http.proxySSLCert', 'http.proxySSLKey', 'http.proxySSLCAInfo']);
  });

  it.each(['http.sslCert', 'http.sslCAPath', 'http.pinnedPubkey'])(
    'leaves %s alone: git fails the credential run on an empty value of it, and a repository setting of it is refused before the run',
    (key) => {
      expect(PATH_VALUED_HTTP_KEYS).not.toContain(key);
      expect(trustConfigOf('/session/ca.pem').map(([name]) => name)).not.toContain(key);
    },
  );

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
    home = createTempDir();
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
