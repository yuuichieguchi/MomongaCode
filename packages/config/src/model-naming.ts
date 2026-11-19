import { isIP } from 'node:net';
import { isOwnNetworkAddress } from '@momonga/foundation';
import type { ModelNaming } from '@momonga/protocol';

const isOwnNetworkHost = (hostname: string): boolean => {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isIP(host) !== 0) return isOwnNetworkAddress(host);
  return !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost');
};

const textOf = (connection: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(connection, key);
  return typeof value === 'string' ? value : undefined;
};

export const modelNamingOf = (connection: object): ModelNaming => {
  if (Reflect.get(connection, 'plan') !== undefined) return 'account';
  if (textOf(connection, 'adapter') === 'managed' || textOf(connection, 'socketPath') !== undefined) return 'server';
  const baseUrl = textOf(connection, 'baseUrl');
  if (baseUrl === undefined || !URL.canParse(baseUrl)) return 'account';
  return isOwnNetworkHost(new URL(baseUrl).hostname) ? 'server' : 'account';
};
