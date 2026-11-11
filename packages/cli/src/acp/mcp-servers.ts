import { RequestError } from '@agentclientprotocol/sdk';
import type { McpServer } from '@agentclientprotocol/sdk';
import { serverKeyOfLabel } from '@momonga/config';
import type { McpServerConfig } from '@momonga/config';

const recordOf = (entries: readonly { readonly name: string; readonly value: string }[]): Record<string, string> =>
  Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));

const configOf = (server: McpServer): McpServerConfig => {
  if ('command' in server) return { type: 'stdio', command: server.command, args: [...server.args], env: recordOf(server.env) };
  if (server.type === 'sse') {
    throw RequestError.invalidParams({ name: server.name }, `the MCP server ${server.name} uses the sse transport, which this agent does not support`);
  }
  return { type: 'http', url: server.url, headers: recordOf(server.headers) };
};

export const mcpServersOf = (servers: readonly McpServer[]): Record<string, McpServerConfig> => {
  const configs = new Map<string, McpServerConfig>();
  for (const server of servers) {
    const derived = serverKeyOfLabel(server.name, new Set(configs.keys()));
    if (derived.kind === 'refused') throw RequestError.invalidParams({ name: server.name }, derived.reason);
    configs.set(derived.key, configOf(server));
  }
  return Object.fromEntries(configs);
};
