import { describe, expect, it } from 'vitest';
import { resolveNetwork } from '@momonga/config';
import type { Route } from '@momonga/foundation';
import { networkCheckLines, networkJson, networkLines } from '../../src/tui/commands/network.ts';
import type { NetworkView } from '../../src/tui/commands/network.ts';

const TRUST = { sources: [{ source: 'bundled' as const, certificates: 140 }, { source: 'system' as const, certificates: 12 }, { source: 'network.extraCaFiles' as const, file: '/etc/corp-ca.pem', certificates: 1 }], failures: [] };

const viewOf = (settings: NetworkView['settings'], env: NetworkView['env']): NetworkView => ({ settings, env, trust: TRUST });

describe('/network (design-proxy-ca 3.4, 3.5)', () => {
  it('prints each value with its source and says when a setting overrides a variable', () => {
    const lines = networkLines(viewOf({ httpsProxy: 'http://proxy.corp:8080' }, { HTTPS_PROXY: 'http://other:3128', NO_PROXY: 'localhost,.corp' }));
    expect(lines).toContain('HTTPS proxy: http://proxy.corp:8080  from network.httpsProxy (overrides HTTPS_PROXY)');
    expect(lines).toContain('HTTP proxy: none');
    expect(lines).toContain('No proxy for: localhost,.corp  from NO_PROXY');
    expect(lines).toContain('Trusted certificates: bundled 140, system 12, /etc/corp-ca.pem 1 (network.extraCaFiles)');
  });

  it('never prints the credentials of a proxy URL, in the lines or in --json', () => {
    const view = viewOf({ httpsProxy: 'http://alice:s3cret@proxy.corp:8080' }, {});
    expect(networkLines(view).join('\n')).not.toMatch(/alice|s3cret/);
    expect(JSON.stringify(networkJson(view))).not.toMatch(/alice|s3cret/);
    expect(networkJson(view)).toMatchObject({ httpsProxy: { value: 'http://proxy.corp:8080', source: 'network.httpsProxy', overrides: [] } });
  });

  it('reports the hop of a check and the source of a failure', () => {
    const config = resolveNetwork({ httpsProxy: 'http://proxy.corp:8080' }, {});
    const route: Route = { kind: 'proxy', url: new URL('http://proxy.corp:8080'), display: 'http://proxy.corp:8080', source: 'network.httpsProxy' };
    expect(config.httpsProxy?.source).toBe('network.httpsProxy');
    expect(networkCheckLines('https://example.com', { route, result: { kind: 'answered', status: 200 } })).toEqual(['https://example.com: through the proxy http://proxy.corp:8080 from network.httpsProxy', 'answered 200']);
    expect(networkCheckLines('https://example.com', { route, result: { kind: 'failed', hop: 'proxy', text: 'the proxy http://proxy.corp:8080 from network.httpsProxy could not be reached (ECONNREFUSED)' } })).toEqual([
      'https://example.com: through the proxy http://proxy.corp:8080 from network.httpsProxy',
      'failed at the proxy: the proxy http://proxy.corp:8080 from network.httpsProxy could not be reached (ECONNREFUSED)',
    ]);
    expect(networkCheckLines('https://example.com', { route: { kind: 'bypass', source: 'NO_PROXY' }, result: { kind: 'answered', status: 204 } })[0]).toBe('https://example.com: direct, NO_PROXY names the host');
  });
});
