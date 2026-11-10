import { describe, expect, it } from 'vitest';
import { NETWORK_SCOPE_KINDS, NO_NETWORK, OPEN_NETWORK, describeNetworkScope, enforcedNetworkScope, meetNetworkScopes, networkScopeOfRequest, networkScopeWithin, normalizedHosts, parseHostEntry } from '@momonga/foundation';
import type { NetworkScope, NetworkScopeKind } from '@momonga/foundation';

const hosts = (...names: string[]): NetworkScope => ({ kind: 'hosts', hosts: names });

const UNIVERSE: readonly NetworkScope[] = [NO_NETWORK, OPEN_NETWORK, hosts('a.test'), hosts('b.test'), hosts('a.test', 'b.test'), hosts('a.test:443'), hosts('a.test:443', 'b.test:80')];

const BACKENDS: ReadonlyArray<readonly NetworkScopeKind[]> = [['none'], ['none', 'open'], ['none', 'hosts', 'open']];

describe('the network scope of a call', () => {
  it('has three kinds, in the order of the lattice', () => {
    expect(NETWORK_SCOPE_KINDS).toEqual(['none', 'hosts', 'open']);
  });

  it('reads an absent request as no network, open as open, and hosts as a sorted set', () => {
    expect(networkScopeOfRequest(undefined)).toEqual({ kind: 'none' });
    expect(networkScopeOfRequest('open')).toEqual({ kind: 'open' });
    expect(networkScopeOfRequest({ hosts: ['B.test', 'a.test:443', 'b.test'] })).toEqual({ kind: 'hosts', hosts: ['a.test:443', 'b.test'] });
  });

  it.each([
    ['registry.example.org', { host: 'registry.example.org', port: undefined }],
    ['Registry.Example.org:443', { host: 'registry.example.org', port: 443 }],
    ['127.0.0.1:8080', { host: '127.0.0.1', port: 8080 }],
    ['[::1]:443', { host: '::1', port: 443 }],
    ['::1', { host: '::1', port: undefined }],
  ])('parses the host entry %j', (text, expected) => {
    expect(parseHostEntry(text)).toEqual(expected);
  });

  it.each(['', '*.example.org', 'https://example.org', 'example.org/path', 'example.org:0', 'example.org:70000', 'a b', '-a.test', '[::1', 'exa_mple.org'])('refuses the host entry %j', (text) => {
    expect(parseHostEntry(text)).toBeUndefined();
    expect(() => normalizedHosts([text])).toThrow(TypeError);
  });

  it('never lets the enforced scope be wider than the request, the grant or the backend (I4.1)', () => {
    for (const requested of UNIVERSE) {
      for (const granted of UNIVERSE) {
        for (const backend of BACKENDS) {
          const enforced = enforcedNetworkScope({ requested, granted, backend });
          expect(networkScopeWithin(enforced, requested)).toBe(true);
          expect(networkScopeWithin(enforced, granted)).toBe(true);
          expect(backend).toContain(enforced.kind);
        }
      }
    }
  });

  it('gives the widest scope that is within both, for every pair', () => {
    for (const first of UNIVERSE) {
      for (const second of UNIVERSE) {
        const meet = meetNetworkScopes(first, second);
        for (const candidate of UNIVERSE) {
          if (networkScopeWithin(candidate, first) && networkScopeWithin(candidate, second)) expect(networkScopeWithin(candidate, meet)).toBe(true);
        }
      }
    }
  });

  it('orders host sets by inclusion, and a host with a port below the host', () => {
    expect(networkScopeWithin(hosts('a.test'), hosts('a.test', 'b.test'))).toBe(true);
    expect(networkScopeWithin(hosts('a.test', 'b.test'), hosts('a.test'))).toBe(false);
    expect(networkScopeWithin(hosts('a.test:443'), hosts('a.test'))).toBe(true);
    expect(networkScopeWithin(hosts('a.test'), hosts('a.test:443'))).toBe(false);
    expect(networkScopeWithin(OPEN_NETWORK, hosts('a.test'))).toBe(false);
  });

  it('names each scope in words a person reads in an approval', () => {
    expect(describeNetworkScope(NO_NETWORK)).toBe('no network access');
    expect(describeNetworkScope(OPEN_NETWORK)).toBe('unrestricted network access');
    expect(describeNetworkScope(hosts('a.test', 'b.test:443'))).toBe('network access to a.test, b.test:443 only');
  });
});
