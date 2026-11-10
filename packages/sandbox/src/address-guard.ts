import net from 'node:net';

const guarded = new net.BlockList();
guarded.addSubnet('0.0.0.0', 8, 'ipv4');
guarded.addSubnet('10.0.0.0', 8, 'ipv4');
guarded.addSubnet('127.0.0.0', 8, 'ipv4');
guarded.addSubnet('169.254.0.0', 16, 'ipv4');
guarded.addSubnet('172.16.0.0', 12, 'ipv4');
guarded.addSubnet('192.168.0.0', 16, 'ipv4');
guarded.addAddress('::', 'ipv6');
guarded.addAddress('::1', 'ipv6');
guarded.addSubnet('fe80::', 10, 'ipv6');
guarded.addSubnet('fc00::', 7, 'ipv6');

const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

export const isGuardedAddress = (address: string): boolean => {
  const mapped = MAPPED_IPV4.exec(address);
  if (mapped !== null) return guarded.check(mapped[1] as string, 'ipv4');
  const family = net.isIP(address);
  if (family === 0) throw new TypeError(`${JSON.stringify(address)} is not an IP address`);
  return guarded.check(address, family === 4 ? 'ipv4' : 'ipv6');
};
