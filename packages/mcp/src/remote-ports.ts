import type { McpCredentialStore } from './mcp-oauth.ts';
import type { HostResolver } from './remote-policy.ts';

export type McpRemotePorts = {
  credentials: McpCredentialStore;
  randomToken(): string;
  openAuthorizationUrl(url: URL, signal: AbortSignal): Promise<void>;
  resolver?: HostResolver;
};
