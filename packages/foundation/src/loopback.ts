import { BlockList, isIP } from 'node:net';

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

export const normalizedHost = (host: string): string => {
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return unbracketed.toLowerCase().replace(/\.$/, '');
};

export const isLoopbackHost = (host: string): boolean => {
  const name = normalizedHost(host);
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  const family = isIP(name);
  return family !== 0 && LOOPBACK_ADDRESSES.check(name, family === 4 ? 'ipv4' : 'ipv6');
};

export type TransportUrlProblem = 'unparseable' | 'userinfo' | 'cleartext';

export const redactedUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '<unparseable URL>';
  }
  return `${url.protocol}//${url.host}${url.pathname}`;
};

export const transportUrlProblem = (raw: string): TransportUrlProblem | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'unparseable';
  }
  if (url.username !== '' || url.password !== '') return 'userinfo';
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
  return secure ? undefined : 'cleartext';
};

export const transportUrlMessage = (what: string, raw: string, problem: TransportUrlProblem): string => {
  switch (problem) {
    case 'unparseable':
      return `${what} is not a valid URL`;
    case 'userinfo':
      return `${what} must not contain userinfo`;
    case 'cleartext':
      return `${what} ${redactedUrl(raw)} must use https: (http: is only allowed for loopback hosts)`;
  }
};
