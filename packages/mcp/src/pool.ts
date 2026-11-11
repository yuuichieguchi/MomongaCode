import type { CredentialRules, McpServerEntry } from '@momonga/config';
import type { Clock, FileSystem } from '@momonga/foundation';
import type { ToolSource } from '@momonga/tools';
import type { McpRemotePorts } from './remote-ports.ts';
import type { CloseGrace, McpMarkerOptions } from './stdio-transport.ts';
import type { McpTimers } from './timers.ts';
import type { McpTransportKind } from './call-bounds.ts';
import { createManagedConnection } from './connection.ts';
import type { McpAuthProbe, McpServerDiagnostics } from './connection.ts';
import { createMcpToolSource } from './source.ts';

export type McpPoolOptions = {
  servers: readonly McpServerEntry[];
  projectDir: string;
  baseEnv: Record<string, string>;
  files: FileSystem;
  clock: Clock;
  clientVersion: string;
  credentials?: CredentialRules;
  credentialNames?: readonly string[];
  timers?: McpTimers;
  remote?: McpRemotePorts;
  random?: () => number;
  requestTimeoutMs?: number;
  toolIdleTimeoutNetworkMs?: number;
  toolIdleTimeoutStdioMs?: number;
  toolTotalTimeoutMs?: number;
  connectTimeoutMs?: number;
  resetAfterMs?: number;
  markers?: McpMarkerOptions;
  closeGraceMs?: CloseGrace;
};

export type McpPool = {
  sources: ToolSource[];
  close(graceMs?: number): Promise<void>;
  diagnostics(): McpServerDiagnostics[];
};

export type McpAuthorizingPool = McpPool & {
  authorize(server: string, signal: AbortSignal): Promise<void>;
  authState(server: string, signal: AbortSignal): Promise<McpAuthProbe>;
};

export const createMcpPool = (options: McpPoolOptions): McpAuthorizingPool => {
  const { servers, projectDir, baseEnv, clock, clientVersion } = options;
  const noticesOf = new Map<string, string[]>(servers.map((entry) => [entry.name, []]));
  const connections = servers.map((entry) =>
    createManagedConnection({
      onNotice: (message) => noticesOf.get(entry.name)?.push(message),
      name: entry.name,
      config: entry.config,
      scope: entry.scope,
      projectDir,
      baseEnv,
      files: options.files,
      clock,
      clientVersion,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.credentialNames === undefined ? {} : { credentialNames: options.credentialNames }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.remote === undefined ? {} : { remote: options.remote }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.resetAfterMs === undefined ? {} : { resetAfterMs: options.resetAfterMs }),
      ...(options.markers === undefined ? {} : { markers: options.markers }),
      ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
    }),
  );
  const connectionNamed = (server: string): Promise<(typeof connections)[number]> => {
    const connection = connections.find((candidate) => candidate.name === server);
    return connection === undefined ? Promise.reject(new Error(`no MCP server named "${server}" in this pool`)) : Promise.resolve(connection);
  };
  const idleTimeoutOf = (transport: McpTransportKind): { toolIdleTimeoutMs?: number } => {
    const idle = transport === 'network' ? options.toolIdleTimeoutNetworkMs : options.toolIdleTimeoutStdioMs;
    return idle === undefined ? {} : { toolIdleTimeoutMs: idle };
  };
  return {
    sources: connections.map((connection) =>
      createMcpToolSource({
        server: connection.name,
        connection,
        takeNotices: () => noticesOf.get(connection.name)?.splice(0) ?? [],
        ...idleTimeoutOf(connection.transportKind),
        ...(options.toolTotalTimeoutMs === undefined ? {} : { toolTotalTimeoutMs: options.toolTotalTimeoutMs }),
      }),
    ),
    close: async (graceMs) => {
      await Promise.all(connections.map((connection) => connection.close(graceMs)));
    },
    diagnostics: () => connections.map((connection) => connection.diagnostics()),
    authorize: (server, signal) => connectionNamed(server).then((connection) => connection.authorize(signal)),
    authState: (server, signal) => connectionNamed(server).then((connection) => connection.authState(signal)),
  };
};
