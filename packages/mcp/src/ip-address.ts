import net from 'node:net';

type Cidr4 = readonly [base: number, bits: number];

const ipv4Number = (octets: readonly number[]): number => (((octets[0] as number) << 24) | ((octets[1] as number) << 16) | ((octets[2] as number) << 8) | (octets[3] as number)) >>> 0;

const NON_PUBLIC_V4: readonly Cidr4[] = [
  [ipv4Number([0, 0, 0, 0]), 8],
  [ipv4Number([10, 0, 0, 0]), 8],
  [ipv4Number([100, 64, 0, 0]), 10],
  [ipv4Number([127, 0, 0, 0]), 8],
  [ipv4Number([169, 254, 0, 0]), 16],
  [ipv4Number([172, 16, 0, 0]), 12],
  [ipv4Number([192, 0, 0, 0]), 24],
  [ipv4Number([192, 0, 2, 0]), 24],
  [ipv4Number([192, 88, 99, 0]), 24],
  [ipv4Number([192, 168, 0, 0]), 16],
  [ipv4Number([198, 18, 0, 0]), 15],
  [ipv4Number([198, 51, 100, 0]), 24],
  [ipv4Number([203, 0, 113, 0]), 24],
  [ipv4Number([224, 0, 0, 0]), 4],
  [ipv4Number([240, 0, 0, 0]), 4],
];

const inCidr4 = (value: number, [base, bits]: Cidr4): boolean => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
};

const parseIpv4 = (address: string): number | undefined => {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.some((octet) => !(octet >= 0 && octet <= 255)) ? undefined : ipv4Number(octets);
};

const isPublicIpv4Number = (value: number): boolean => !NON_PUBLIC_V4.some((range) => inCidr4(value, range));

const parseIpv6Groups = (address: string): number[] | undefined => {
  if (address.includes('%')) return undefined;
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const embedded = parseIpv4(tail);
    if (embedded === undefined) return undefined;
    text = `${text.slice(0, lastColon + 1)}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] as string).split(':')) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const values = groups.map((group) => (/^[0-9a-fA-F]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
  return values.some(Number.isNaN) ? undefined : values;
};

const embeddedIpv4 = (high: number, low: number): number => ((high << 16) | low) >>> 0;

const isPublicIpv6Groups = (g: readonly number[]): boolean => {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (leadingZero && g5 === 0xffff) return isPublicIpv4Number(embeddedIpv4(g6, g7));
  if (leadingZero && g5 === 0) return false;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicIpv4Number(embeddedIpv4(g6, g7));
  if (g0 === 0x2002) return isPublicIpv4Number(embeddedIpv4(g1, g2));
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x200) return false;
  if (g0 === 0x2001 && g1 === 0xdb8) return false;
  if (g0 === 0x3fff && g1 < 0x1000) return false;
  return true;
};

export const isPublicAddress = (address: string): boolean => {
  const family = net.isIP(address);
  if (family === 4) {
    const value = parseIpv4(address);
    return value !== undefined && isPublicIpv4Number(value);
  }
  if (family === 6) {
    const groups = parseIpv6Groups(address);
    return groups !== undefined && isPublicIpv6Groups(groups);
  }
  return false;
};

export const isAddressLiteral = (hostname: string): boolean => net.isIP(hostname.startsWith('[') ? hostname.slice(1, -1) : hostname) !== 0;

export const stripBrackets = (hostname: string): string => (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname);
