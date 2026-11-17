import { describe, expect, it } from 'vitest';
import { PATH_VALUED_HTTP_KEYS, trustConfigOf } from '../../src/operations/argv.ts';

describe('the credential step gives git no path-valued http key of the repository', () => {
  it.each(PATH_VALUED_HTTP_KEYS)('neutralises %s', (key) => {
    expect(trustConfigOf('/session/ca.pem')).toContainEqual([key, '']);
  });

  it('keeps the bundle of trusted certificates as the CA file', () => {
    expect(trustConfigOf('/session/ca.pem')).toContainEqual(['http.sslCAInfo', '/session/ca.pem']);
  });

  it('names every path-valued key the git manual lists for http, so none is left to a repository setting', () => {
    expect(PATH_VALUED_HTTP_KEYS).toEqual(
      expect.arrayContaining(['http.sslCert', 'http.sslKey', 'http.proxySSLCert', 'http.proxySSLKey', 'http.proxySSLCAInfo', 'http.sslCAPath', 'http.sslBackend', 'http.pinnedPubkey', 'http.sslCipherList', 'http.sslVersion']),
    );
  });
});
