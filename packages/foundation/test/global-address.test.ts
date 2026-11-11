import { describe, expect, it } from 'vitest';
import { isAcceptableAddress, isLoopbackAddress, isLoopbackHost } from '@momonga/foundation';

const REFUSING_LOOPBACK = { loopback: false } as const;
const ALLOWING_LOOPBACK = { loopback: true } as const;

const NON_GLOBAL: ReadonlyArray<readonly [range: string, address: string]> = [
  ['0.0.0.0/8', '0.0.0.0'],
  ['0.0.0.0/8', '0.255.255.255'],
  ['10.0.0.0/8', '10.1.2.3'],
  ['100.64.0.0/10', '100.64.0.1'],
  ['100.64.0.0/10', '100.127.255.255'],
  ['169.254.0.0/16', '169.254.169.254'],
  ['172.16.0.0/12', '172.16.0.1'],
  ['172.16.0.0/12', '172.31.255.255'],
  ['192.0.0.0/24', '192.0.0.8'],
  ['192.0.2.0/24', '192.0.2.1'],
  ['192.88.99.0/24', '192.88.99.1'],
  ['192.168.0.0/16', '192.168.1.1'],
  ['198.18.0.0/15', '198.18.0.1'],
  ['198.18.0.0/15', '198.19.255.255'],
  ['198.51.100.0/24', '198.51.100.7'],
  ['203.0.113.0/24', '203.0.113.7'],
  ['224.0.0.0/4', '224.0.0.1'],
  ['224.0.0.0/4', '239.255.255.255'],
  ['240.0.0.0/4', '240.0.0.1'],
  ['255.255.255.255/32', '255.255.255.255'],
  ['::/128', '::'],
  ['::/128', '0:0:0:0:0:0:0:0'],
  ['fc00::/7', 'fc00::1'],
  ['fc00::/7', 'fdff:ffff::1'],
  ['fe80::/10', 'fe80::1'],
  ['fe80::/10', 'febf::1'],
  ['fe80::/10 with a zone', 'fe80::1%en0'],
  ['fec0::/10', 'fec0::1'],
  ['fec0::/10', 'feff::1'],
  ['ff00::/8', 'ff02::1'],
  ['ff00::/8', 'ffff::1'],
  ['2001::/23', '2001::1'],
  ['2001:db8::/32', '2001:db8::1'],
  ['3fff::/20', '3fff:0::1'],
  ['outside 2000::/3', '100::1'],
  ['outside 2000::/3', '4000::1'],
];

const LOOPBACK: readonly string[] = ['127.0.0.1', '127.8.9.1', '127.255.255.255', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1'];

const GLOBAL: readonly string[] = ['8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.0.1.1', '198.17.255.255', '198.20.0.1', '223.255.255.255', '2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888', '2a00:1450:4001::1'];

type Embedding = { readonly form: string; readonly of: (ipv4: string) => string };

const hexOf = (ipv4: string): readonly [string, string] => {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
};

const EMBEDDINGS: readonly Embedding[] = [
  { form: 'mapped ::ffff:a.b.c.d', of: (ipv4) => `::ffff:${ipv4}` },
  { form: 'mapped in hexadecimal', of: (ipv4) => `::ffff:${hexOf(ipv4).join(':')}` },
  { form: 'mapped, written in full', of: (ipv4) => `0:0:0:0:0:ffff:${hexOf(ipv4).join(':')}` },
  { form: 'compatible ::a.b.c.d', of: (ipv4) => `::${ipv4}` },
  { form: 'compatible in hexadecimal', of: (ipv4) => `::${hexOf(ipv4).join(':')}` },
  { form: 'NAT64 64:ff9b::/96', of: (ipv4) => `64:ff9b::${ipv4}` },
  { form: 'NAT64 64:ff9b::/96 in hexadecimal', of: (ipv4) => `64:ff9b::${hexOf(ipv4).join(':')}` },
  { form: 'NAT64 64:ff9b:1::/48', of: (ipv4) => `64:ff9b:1::${ipv4}` },
  { form: '6to4 2002::/16', of: (ipv4) => `2002:${hexOf(ipv4).join(':')}::1` },
];

const EMBEDDED_NON_GLOBAL: readonly string[] = ['10.0.0.5', '169.254.169.254', '192.168.1.1', '100.64.0.1', '172.16.0.1', '224.0.0.1', '0.0.0.0'];

describe('the one definition of an address a name may not silently resolve to', () => {
  it.each(NON_GLOBAL)('refuses %s (%s), whether or not loopback is allowed', (_range, address) => {
    expect(isAcceptableAddress(address, REFUSING_LOOPBACK)).toBe(false);
    expect(isAcceptableAddress(address, ALLOWING_LOOPBACK)).toBe(false);
  });

  it.each(GLOBAL)('accepts the global unicast address %s', (address) => {
    expect(isAcceptableAddress(address, REFUSING_LOOPBACK)).toBe(true);
    expect(isAcceptableAddress(address, ALLOWING_LOOPBACK)).toBe(true);
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it.each(LOOPBACK)('refuses the loopback address %s unless the caller allows loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
    expect(isAcceptableAddress(address, REFUSING_LOOPBACK)).toBe(false);
    expect(isAcceptableAddress(address, ALLOWING_LOOPBACK)).toBe(true);
  });

  describe.each(EMBEDDINGS)('an IPv4 address embedded as $form is judged as that IPv4 address', ({ of }) => {
    it.each(EMBEDDED_NON_GLOBAL)('refuses %s', (ipv4) => {
      expect(isAcceptableAddress(of(ipv4), REFUSING_LOOPBACK)).toBe(false);
      expect(isAcceptableAddress(of(ipv4), ALLOWING_LOOPBACK)).toBe(false);
    });

    it('refuses an embedded 127.0.0.1 when loopback is refused', () => {
      expect(isAcceptableAddress(of('127.0.0.1'), REFUSING_LOOPBACK)).toBe(false);
    });

    it('accepts an embedded global address', () => {
      expect(isAcceptableAddress(of('8.8.8.8'), REFUSING_LOOPBACK)).toBe(true);
    });
  });

  it.each(EMBEDDINGS.filter(({ form }) => !form.startsWith('mapped')))('takes 127.0.0.1 embedded as $form for this computer, by the address it carries', ({ of }) => {
    expect(isLoopbackAddress(of('127.0.0.1'))).toBe(true);
    expect(isAcceptableAddress(of('127.0.0.1'), ALLOWING_LOOPBACK)).toBe(true);
  });

  it.each(['example.org', '', '1.2.3', '1.2.3.4.5', ':::', '[::1]', 'localhost'])('throws for %j, which is not an address', (text) => {
    expect(() => isAcceptableAddress(text, REFUSING_LOOPBACK)).toThrow(TypeError);
    expect(() => isLoopbackAddress(text)).toThrow(TypeError);
  });

  it('is the definition the loopback host check reads', () => {
    for (const address of LOOPBACK) expect(isLoopbackHost(address)).toBe(true);
    for (const address of [...GLOBAL, '10.0.0.1', '::']) expect(isLoopbackHost(address)).toBe(false);
    for (const address of ['2002:7f00:1::1', '64:ff9b::127.0.0.1']) expect(isLoopbackHost(address)).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('LOCALHOST.')).toBe(false);
    expect(isLoopbackHost('api.localhost')).toBe(false);
  });
});
