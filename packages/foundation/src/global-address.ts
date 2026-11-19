import { isIP } from 'node:net';

const LOOPBACK_IPV4 = '127.0.0.0/8';
const LOOPBACK_IPV6 = '::1/128';

const OWN_NETWORK_IPV4: readonly string[] = ['10.0.0.0/8', '100.64.0.0/10', LOOPBACK_IPV4, '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'];
const OWN_NETWORK_IPV6: readonly string[] = [LOOPBACK_IPV6, 'fc00::/7', 'fe80::/10'];

const NON_GLOBAL_IPV4: readonly string[] = [
  ...OWN_NETWORK_IPV4,
  '0.0.0.0/8',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
];

const MAPPED_IPV4 = '::ffff:0:0/96';

const IPV4_IN_LAST_32_BITS: readonly string[] = [MAPPED_IPV4, '::/96', '64:ff9b::/96', '64:ff9b:1::/48'];
const IPV4_AFTER_FIRST_16_BITS: readonly string[] = ['2002::/16'];

const GLOBAL_UNICAST_IPV6 = '2000::/3';
const NON_GLOBAL_IPV6: readonly string[] = [...OWN_NETWORK_IPV6, '::/128', '2001::/23', '2001:db8::/32', '3fff::/20', 'fec0::/10', 'ff00::/8'];

type Bits = { readonly value: bigint; readonly width: number };
type Range = { readonly base: bigint; readonly width: number; readonly prefix: number };

const ipv4Bits = (text: string): Bits => ({ value: text.split('.').reduce((sum, octet) => (sum << 8n) | BigInt(Number(octet)), 0n), width: 32 });

const groupsOf = (text: string): string[] => (text === '' ? [] : text.split(':'));

const ipv6Bits = (text: string): Bits => {
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  const dotted = tail.includes('.') ? ipv4Bits(tail).value : undefined;
  const hex = dotted === undefined ? text : `${text.slice(0, lastColon + 1)}${(dotted >> 16n).toString(16)}:${(dotted & 0xffffn).toString(16)}`;
  const [head = '', rest] = hex.split('::');
  const leading = groupsOf(head);
  const trailing = rest === undefined ? [] : groupsOf(rest);
  const groups = [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing];
  return { value: groups.reduce((sum, group) => (sum << 16n) | BigInt(parseInt(group, 16)), 0n), width: 128 };
};

const bitsOf = (address: string): Bits => {
  const text = address.includes('%') ? address.slice(0, address.indexOf('%')) : address;
  const family = isIP(text);
  if (family === 0) throw new TypeError(`${JSON.stringify(address)} is not an IP address`);
  return family === 4 ? ipv4Bits(text) : ipv6Bits(text);
};

const rangeOf = (cidr: string): Range => {
  const slash = cidr.lastIndexOf('/');
  const { value, width } = bitsOf(cidr.slice(0, slash));
  return { base: value, width, prefix: Number(cidr.slice(slash + 1)) };
};

const within = (bits: Bits, range: Range): boolean => bits.width === range.width && bits.value >> BigInt(range.width - range.prefix) === range.base >> BigInt(range.width - range.prefix);

const withinAny = (bits: Bits, ranges: readonly Range[]): boolean => ranges.some((range) => within(bits, range));

const RANGES = {
  nonGlobalIpv4: NON_GLOBAL_IPV4.map(rangeOf),
  nonGlobalIpv6: NON_GLOBAL_IPV6.map(rangeOf),
  ownNetwork: [...OWN_NETWORK_IPV4, ...OWN_NETWORK_IPV6].map(rangeOf),
  globalUnicastIpv6: rangeOf(GLOBAL_UNICAST_IPV6),
  loopback: [rangeOf(LOOPBACK_IPV4), rangeOf(LOOPBACK_IPV6)],
  ipv4InLast32Bits: IPV4_IN_LAST_32_BITS.map(rangeOf),
  ipv4AfterFirst16Bits: IPV4_AFTER_FIRST_16_BITS.map(rangeOf),
} as const;

const IPV4_MASK = 0xffffffffn;

const lowIpv4 = (bits: Bits): Bits => ({ value: bits.value & IPV4_MASK, width: 32 });

const embeddedIpv4 = (bits: Bits): Bits | undefined => {
  if (withinAny(bits, RANGES.ipv4InLast32Bits)) return lowIpv4(bits);
  if (withinAny(bits, RANGES.ipv4AfterFirst16Bits)) return { value: (bits.value >> 80n) & IPV4_MASK, width: 32 };
  return undefined;
};

const isLoopbackBits = (bits: Bits): boolean => withinAny(bits, RANGES.loopback) || withinAny(embeddedIpv4(bits) ?? bits, RANGES.loopback);

const isGlobalUnicastBits = (bits: Bits): boolean => {
  if (bits.width === 32) return !withinAny(bits, RANGES.nonGlobalIpv4);
  if (withinAny(bits, RANGES.loopback)) return false;
  const embedded = embeddedIpv4(bits);
  if (embedded !== undefined) return isGlobalUnicastBits(embedded);
  return within(bits, RANGES.globalUnicastIpv6) && !withinAny(bits, RANGES.nonGlobalIpv6);
};

export type AddressAllowance = { readonly loopback: boolean };

export const isLoopbackAddress = (address: string): boolean => isLoopbackBits(bitsOf(address));

export const isOwnNetworkAddress = (address: string): boolean => withinAny(bitsOf(address), RANGES.ownNetwork);

export const isAddressInRange = (address: string, cidr: string): boolean => within(bitsOf(address), rangeOf(cidr));

export const isAcceptableAddress = (address: string, allow: AddressAllowance): boolean => {
  const bits = bitsOf(address);
  if (isLoopbackBits(bits)) return allow.loopback;
  return isGlobalUnicastBits(bits);
};
