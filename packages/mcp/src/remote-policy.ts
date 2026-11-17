import dns from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import type { RequestInit as UndiciRequestInit } from 'undici';
import type { FetchLike } from '@modelcontextprotocol/client';
import { mcpServerUrlProblemOf } from '@momonga/config';
import type { McpServerScope } from '@momonga/config';
import { claimsLoopback, createOutboundDispatcher, findOutboundError, isAcceptableAddress, outboundFetch } from '@momonga/foundation';
import type { OutboundNetwork } from '@momonga/foundation';
import { McpRemotePolicyError } from './remote-errors.ts';

export type ResolvedAddress = { address: string; family: number };

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: HostResolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

const PUBLIC_ONLY = { loopback: false } as const;

const withoutBrackets = (hostname: string): string => (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname);

export const assertRemoteUrl = (text: string, scope: McpServerScope): URL => {
  const url = new URL(text);
  const problem = mcpServerUrlProblemOf(url, scope);
  if (problem !== undefined) throw new McpRemotePolicyError(problem.code, problem.message);
  if (scope === 'project') {
    const host = url.hostname.replace(/\.$/, '');
    const literal = withoutBrackets(host);
    if (isIP(literal) !== 0 && !isAcceptableAddress(literal, PUBLIC_ONLY)) {
      throw new McpRemotePolicyError('non_public_address_literal', `project-scope MCP server URL points at a non-public address (${host})`);
    }
    if (claimsLoopback(host)) {
      throw new McpRemotePolicyError('loopback_hostname', `project-scope MCP server URL points at a loopback host name (${host})`);
    }
  }
  return url;
};

export const assertAuthorizationUrl = (url: URL, scope: McpServerScope): void => {
  if (mcpServerUrlProblemOf(url, scope)?.code === 'scheme') {
    throw new McpRemotePolicyError('authorization_url_scheme', `refusing to open an authorization URL with scheme ${url.protocol.replace(':', '')}`);
  }
  assertRemoteUrl(url.href, scope);
};

const USER_SCOPE_NOTE = 'a server added in user settings is not subject to this check';

const codeOrMessageOf = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  return 'code' in error && typeof error.code === 'string' ? error.code : error.message;
};

const lookupVia = (resolver: HostResolver, setting: string): LookupFunction => {
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new McpRemotePolicyError('unresolvable_host', `${hostname}, the host of the URL in ${setting}, did not resolve to any address, so its address could not be verified; ${USER_SCOPE_NOTE}`));
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
          new McpRemotePolicyError('unresolvable_host', `the address of ${hostname}, the host of the URL in ${setting}, could not be verified: the name did not resolve on this machine (${codeOrMessageOf(error)}); ${USER_SCOPE_NOTE}`, {
            cause: error,
          }),
        ),
    );
  };
  return lookup as unknown as LookupFunction;
};

export type GuardedFetch = { fetch: FetchLike; close(): Promise<void> };

type Send = (url: URL, init: RequestInit | undefined) => Promise<Response>;

export type GuardedScope = { scope: 'project'; setting: string } | { scope: Exclude<McpServerScope, 'project'> };

export type GuardedFetchOptions = GuardedScope & { network: OutboundNetwork; connectTimeoutMs: number; resolver: HostResolver; send?: Send };

type RoutedResponse = Awaited<ReturnType<ReturnType<typeof outboundFetch>>>;

export const globalResponseOf = (response: RoutedResponse): Response => {
  const headers = new Headers();
  response.headers.forEach((value, name) => headers.append(name, value));
  return new Response(response.body as ReadableStream<Uint8Array> | null, { status: response.status, statusText: response.statusText, headers });
};

export const createGuardedFetch = (options: GuardedFetchOptions): GuardedFetch => {
  const { scope, network, connectTimeoutMs, resolver, send } = options;
  const dispatcher = createOutboundDispatcher(network, {
    connectReplyTimeoutMs: connectTimeoutMs,
    headersTimeout: 0,
    bodyTimeout: 0,
    ...(options.scope === 'project' ? { lookup: lookupVia(resolver, options.setting) } : {}),
  });
  const routed = outboundFetch(dispatcher);
  const dispatch: Send =
    send ??
    (async (url, init) => {
      try {
        return globalResponseOf(await routed(url, init as UndiciRequestInit | undefined));
      } catch (error) {
        throw findOutboundError(error) ?? error;
      }
    });
  return {
    fetch: async (input, init) => dispatch(assertRemoteUrl(String(input), scope), { ...init, redirect: init?.redirect === 'error' ? 'error' : 'manual' }),
    close: () => dispatcher.destroy(),
  };
};
