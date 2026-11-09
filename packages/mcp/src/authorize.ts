import { auth, extractWWWAuthenticateParams, validateAuthorizationResponseIssuer } from '@modelcontextprotocol/client';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { McpServerScope } from '@momonga/config';
import type { McpCredentialStore } from './mcp-oauth.ts';
import { AUTHORIZATION_WAIT_MS, startLoopbackRedirect } from '@momonga/foundation';
import { createMcpOAuthProvider } from './mcp-oauth.ts';
import { McpAuthorizationError } from './remote-errors.ts';
import { sanitizeServerText, capText } from './text.ts';
import type { McpTimers } from './timers.ts';

const MAX_ERROR_CHARS = 200;

export type McpOAuthSettings = { clientId?: string; scope?: string; callbackPort?: number };

export type McpAuthorizationPorts = {
  store: McpCredentialStore;
  timers: McpTimers;
  randomToken(): string;
  openAuthorizationUrl(url: URL, signal: AbortSignal): Promise<void>;
};

export type AuthorizeMcpServerOptions = {
  server: string;
  url: string;
  scope: McpServerScope;
  oauth: McpOAuthSettings | undefined;
  fetch: FetchLike;
  ports: McpAuthorizationPorts;
  signal: AbortSignal;
  waitMs?: number;
  resourceMetadataUrl?: URL;
};

const PROBE_BODY = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' });

const challengeOf = async (fetch: FetchLike, url: string, signal: AbortSignal): Promise<{ resourceMetadataUrl?: URL; scope?: string }> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: PROBE_BODY,
    signal,
  });
  await response.body?.cancel();
  return response.status === 401 ? extractWWWAuthenticateParams(response) : {};
};

export const authorizeMcpServer = async (options: AuthorizeMcpServerOptions): Promise<void> => {
  const { ports, oauth, signal } = options;
  const redirect = await startLoopbackRedirect({ port: oauth?.callbackPort ?? 0, timers: ports.timers });
  try {
    let authorizationUrl: URL | undefined;
    const provider = createMcpOAuthProvider({
      server: options.server,
      resourceUrl: options.url,
      scope: options.scope,
      store: ports.store,
      signal,
      redirectUrl: redirect.redirectUrl,
      randomToken: ports.randomToken,
      ...(oauth?.clientId === undefined ? {} : { preregisteredClientId: oauth.clientId }),
      ...(oauth?.scope === undefined ? {} : { requestedScope: oauth.scope }),
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
    });
    const challenge = await challengeOf(options.fetch, options.url, signal);
    const scope = oauth?.scope ?? challenge.scope;
    const resourceMetadataUrl = options.resourceMetadataUrl ?? challenge.resourceMetadataUrl;
    const common = {
      serverUrl: options.url,
      fetchFn: options.fetch,
      ...(scope === undefined ? {} : { scope }),
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
    };
    if ((await auth(provider, common)) === 'AUTHORIZED') return;
    if (authorizationUrl === undefined || provider.expectedState === undefined) {
      throw new McpAuthorizationError('required', `MCP server "${options.server}" did not produce an authorization request`);
    }
    const waiting = new AbortController();
    const abortWaiting = (): void => waiting.abort(signal.reason);
    signal.addEventListener('abort', abortWaiting, { once: true });
    const arrived = redirect.callback({ state: provider.expectedState, signal: waiting.signal, timeoutMs: options.waitMs ?? AUTHORIZATION_WAIT_MS });
    let params: URLSearchParams;
    try {
      await ports.openAuthorizationUrl(authorizationUrl, signal);
      params = await arrived;
    } catch (error) {
      waiting.abort(error);
      await arrived.catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener('abort', abortWaiting);
    }
    const iss = params.get('iss') ?? undefined;
    const recorded = provider.recordedIssuer;
    if (recorded === undefined) throw new McpAuthorizationError('invalid_callback', `the authorization server of MCP server "${options.server}" was not recorded before the redirect`);
    validateAuthorizationResponseIssuer({ iss, expectedIssuer: recorded.issuer, issParameterSupported: recorded.issParameterSupported });
    const refusal = params.get('error');
    if (refusal !== null) {
      throw new McpAuthorizationError('denied', `authorization for MCP server "${options.server}" was refused (${capText(sanitizeServerText(refusal), MAX_ERROR_CHARS)})`);
    }
    const code = params.get('code');
    if (code === null) throw new McpAuthorizationError('invalid_callback', `the authorization response of MCP server "${options.server}" carried no code`);
    await auth(provider, { ...common, authorizationCode: code, ...(iss === undefined ? {} : { iss }) });
  } finally {
    await redirect.close();
  }
};
