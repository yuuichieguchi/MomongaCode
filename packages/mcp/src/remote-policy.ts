import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { McpServerScope } from '@momonga/config';
import { isAddressLiteral, isPublicAddress, stripBrackets } from './ip-address.ts';
import { McpRemotePolicyError } from './remote-errors.ts';

export type ResolvedAddress = { address: string; family: number };

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: HostResolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

const LOOPBACK_NAME = /(^|\.)localhost$/;

const allowedSchemes = (scope: McpServerScope): readonly string[] => (scope === 'project' ? ['https:'] : ['https:', 'http:']);

export const assertRemoteUrl = (text: string, scope: McpServerScope): URL => {
  const url = new URL(text);
  if (!allowedSchemes(scope).includes(url.protocol)) {
    throw new McpRemotePolicyError('scheme', `${scope}-scope MCP server URLs must use ${allowedSchemes(scope).join(' or ').replaceAll(':', '')}; got ${url.protocol.replace(':', '')}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new McpRemotePolicyError('credentials_in_url', 'MCP server URLs must not embed credentials; use headers or OAuth');
  }
  if (scope === 'project') {
    const host = url.hostname.replace(/\.$/, '');
    if (isAddressLiteral(host) && !isPublicAddress(stripBrackets(host))) {
      throw new McpRemotePolicyError('non_public_address_literal', `project-scope MCP server URL points at a non-public address (${host})`);
    }
    if (LOOPBACK_NAME.test(host)) {
      throw new McpRemotePolicyError('loopback_hostname', `project-scope MCP server URL points at a loopback host name (${host})`);
    }
  }
  return url;
};

export const assertAuthorizationUrl = (url: URL, scope: McpServerScope): void => {
  if (!allowedSchemes(scope).includes(url.protocol)) {
    throw new McpRemotePolicyError('authorization_url_scheme', `refusing to open an authorization URL with scheme ${url.protocol.replace(':', '')}`);
  }
};

const lookupVia = (resolver: HostResolver): LookupFunction => {
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new McpRemotePolicyError('unresolvable_host', `${hostname} did not resolve to any address`));
          return;
        }
        const refused = addresses.find((entry) => !isPublicAddress(entry.address));
        if (refused !== undefined) {
          callback(new McpRemotePolicyError('non_public_resolved_address', `${hostname} resolves to a non-public address (${refused.address})`));
          return;
        }
        if (options.all === true) callback(null, addresses);
        else callback(null, (addresses[0] as ResolvedAddress).address, (addresses[0] as ResolvedAddress).family);
      },
      (error: unknown) => callback(error),
    );
  };
  return lookup as unknown as LookupFunction;
};

export type GuardedFetch = { fetch: FetchLike; close(): Promise<void> };

export type GuardedFetchOptions = { scope: McpServerScope; resolver?: HostResolver };

export const createGuardedFetch = ({ scope, resolver = systemResolver }: GuardedFetchOptions): GuardedFetch => {
  const agent = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    ...(scope === 'project' ? { connect: { lookup: lookupVia(resolver) } } : {}),
  });
  return {
    fetch: async (input, init) => {
      assertRemoteUrl(String(input), scope);
      return undiciFetch(input, { ...(init as UndiciRequestInit | undefined), dispatcher: agent }) as unknown as Awaited<ReturnType<FetchLike>>;
    },
    close: () => agent.destroy(),
  };
};
