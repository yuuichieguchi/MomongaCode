import { createHash } from 'node:crypto';
import path from 'node:path';
import type { McpServerScope } from '@momonga/config';
import { createOAuthProvider } from '@momonga/foundation';
import type { CredentialStore, MomongaPaths, OAuthProvider } from '@momonga/foundation';
import { assertAuthorizationUrl } from './remote-policy.ts';

export type McpCredentialStore = CredentialStore;

export const mcpCredentialDirectory = (paths: Pick<MomongaPaths, 'state'>): string => path.join(paths.state, 'mcp-credentials');

export const credentialKey = (server: string, resourceUrl: string): string =>
  `mcp-oauth/${server}/${createHash('sha256').update(resourceUrl).digest('hex').slice(0, 32)}`;

export type McpOAuthProviderOptions = {
  server: string;
  resourceUrl: string;
  scope: McpServerScope;
  store: McpCredentialStore;
  signalForCall(): AbortSignal;
  redirectUrl: string | undefined;
  randomToken(): string;
  preregisteredClientId?: string;
  requestedScope?: string;
  onAuthorizationUrl(url: URL): void;
  onSecret?(value: string): void;
};

export type McpOAuthProvider = OAuthProvider;

export const createMcpOAuthProvider = (options: McpOAuthProviderOptions): McpOAuthProvider =>
  createOAuthProvider({
    key: credentialKey(options.server, options.resourceUrl),
    subject: `MCP server "${options.server}"`,
    store: options.store,
    signalForCall: options.signalForCall,
    redirectUrl: options.redirectUrl,
    randomToken: options.randomToken,
    ...(options.preregisteredClientId === undefined ? {} : { preregisteredClientId: options.preregisteredClientId }),
    ...(options.requestedScope === undefined ? {} : { requestedScope: options.requestedScope }),
    onAuthorizationUrl: (url) => {
      assertAuthorizationUrl(url, options.scope);
      options.onAuthorizationUrl(url);
    },
    ...(options.onSecret === undefined ? {} : { onSecret: options.onSecret }),
  });
