import type { McpServerEntry } from '@momonga/config';
import type { Clock } from '@momonga/foundation';
import type { ToolSource } from '@momonga/tools';
import { createManagedConnection } from './connection.ts';
import type { McpServerDiagnostics } from './connection.ts';
import { createMcpToolSource } from './source.ts';

export type McpPoolOptions = {
  servers: readonly McpServerEntry[];
  projectDir: string;
  baseEnv: Record<string, string>;
  clock: Clock;
  random?: () => number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  resetAfterMs?: number;
};

export type McpPool = {
  sources: ToolSource[];
  close(): Promise<void>;
  diagnostics(): McpServerDiagnostics[];
};

export const createMcpPool = (options: McpPoolOptions): McpPool => {
  const { servers, projectDir, baseEnv, clock } = options;
  const connections = servers.map((entry) =>
    createManagedConnection({
      name: entry.name,
      config: entry.config,
      projectDir,
      baseEnv,
      clock,
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
      ...(options.resetAfterMs === undefined ? {} : { resetAfterMs: options.resetAfterMs }),
    }),
  );
  return {
    sources: connections.map((connection) =>
      createMcpToolSource({
        server: connection.name,
        connection,
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      }),
    ),
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close()));
    },
    diagnostics: () => connections.map((connection) => connection.diagnostics()),
  };
};
