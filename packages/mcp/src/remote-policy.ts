import dns from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import type { RequestInit as UndiciRequestInit } from 'undici';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { McpServerScope } from '@momonga/config';
import { createOutboundDispatcher, findOutboundError, isAcceptableAddress, outboundFetch } from '@momonga/foundation';
import type { OutboundNetwork } from '@momonga/foundation';
import { McpRemotePolicyError } from './remote-errors.ts';

export type ResolvedAddress = { address: string; family: number };

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: HostResolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

const PUBLIC_ONLY = { loopback: false } as const;

const withoutBrackets = (hostname: string): string => (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname);

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
    const literal = withoutBrackets(host);
    if (isIP(literal) !== 0 && !isAcceptableAddress(literal, PUBLIC_ONLY)) {
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
  assertRemoteUrl(url.href, scope);
};

const USER_SCOPE_NOTE = 'a server added in user settings is not subject to this check';

const codeOrMessageOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  return 'code' in error && typeof error.code === 'string' ? error.code : error.message;
};

const lookupVia = (resolver: HostResolver): LookupFunction => {
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new McpRemotePolicyError('unresolvable_host', `${hostname} did not resolve to any address, so its address could not be verified; ${USER_SCOPE_NOTE}`));
          return;
        }
        const refused = addresses.find((entry) => !isAcceptableAddress(entry.address, PUBLIC_ONLY));
        if (refused !== undefined) {
          callback(new McpRemotePolicyError('non_public_resolved_address', `${hostname} resolves to a non-public address (${refused.address}); ${USER_SCOPE_NOTE}`));
          return;
        }
        if (options.all === true) callback(null, addresses);
        else callback(null, (addresses[0] as ResolvedAddress).address, (addresses[0] as ResolvedAddress).family);
      },
      (error: unknown) =>
        callback(
          new McpRemotePolicyError('unresolvable_host', `the address of ${hostname} could not be verified: the name did not resolve on this machine (${codeOrMessageOf(error)}); ${USER_SCOPE_NOTE}`, {
            cause: error,
          }),
        ),
    );
  };
  return lookup as unknown as LookupFunction;
};

export type GuardedFetch = { fetch: FetchLike; close(): Promise<void> };

type Send = (url: URL, init: RequestInit | undefined) => Promise<Response>;

export type GuardedFetchOptions = { scope: McpServerScope; network: OutboundNetwork; connectTimeoutMs: number; resolver?: HostResolver; send?: Send };

export const createGuardedFetch = ({ scope, network, connectTimeoutMs, resolver = systemResolver, send }: GuardedFetchOptions): GuardedFetch => {
  const dispatcher = createOutboundDispatcher(network, {
    connectReplyTimeoutMs: connectTimeoutMs,
    headersTimeout: 0,
    bodyTimeout: 0,
    ...(scope === 'project' ? { lookup: lookupVia(resolver) } : {}),
  });
  const routed = outboundFetch(dispatcher);
  const dispatch: Send =
    send ??
    (async (url, init) => {
      try {
        return (await routed(url, init as UndiciRequestInit | undefined)) as unknown as Response;
      } catch (error) {
        throw findOutboundError(error) ?? error;
      }
    });
  return {
    fetch: async (input, init) => dispatch(assertRemoteUrl(String(input), scope), { ...init, redirect: init?.redirect === 'error' ? 'error' : 'manual' }),
    close: () => dispatcher.destroy(),
  };
};
