import { EXIT_INTERRUPTED } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { escapeTerminalLine } from '@momonga/protocol';
import type { McpAuthorizationView, McpServerView } from '@momonga/protocol';
import { browserNotOpenedLine, cancelledLine } from '../plan/texts.ts';
import { AUTHORIZATION_POLL_INTERVAL_MS } from '../constants.ts';
import { mcpLoginCommand } from '../mcp/messages.ts';
import { pollUntil } from '../poll.ts';
import type { CliPorts } from '../ports.ts';
import type { McpFolder, RuntimeClient } from '../client/runtime-client.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import { connectRuntime, environmentSnapshot } from '../run/open-session.ts';
import { escapedLines } from '../terminal-writer.ts';

export class McpLoginFailed extends Error {
  readonly server: string;
  readonly code: string;

  constructor(server: string, code: string, message: string) {
    super(message);
    this.name = 'McpLoginFailed';
    this.server = server;
    this.code = code;
  }
}

const column = (values: readonly string[]): number => Math.max(...values.map((value) => value.length));

export const mcpAuthorizationInvitation = (server: string, url: string): string => escapedLines([`Authorize MCP server ${server} in your browser:`, url]);

export const formatMcpServers = (servers: readonly McpServerView[]): string => {
  if (servers.length === 0) return 'no MCP servers are configured for this folder';
  const rows = servers.map((server) => ({
    name: escapeTerminalLine(server.name),
    scope: escapeTerminalLine(server.scope),
    transport: escapeTerminalLine(server.transport),
    auth: escapeTerminalLine(server.auth),
    detail: escapeTerminalLine([server.url, server.detail, server.auth === 'required' ? `run: ${mcpLoginCommand(server.name)}` : undefined].filter((part) => part !== undefined).join('  ')),
  }));
  const widths = { name: column(['NAME', ...rows.map((row) => row.name)]), scope: column(['SCOPE', ...rows.map((row) => row.scope)]), transport: column(['TRANSPORT', ...rows.map((row) => row.transport)]), auth: column(['AUTH', ...rows.map((row) => row.auth)]) };
  const line = (row: { name: string; scope: string; transport: string; auth: string; detail: string }): string =>
    `${row.name.padEnd(widths.name)}  ${row.scope.padEnd(widths.scope)}  ${row.transport.padEnd(widths.transport)}  ${row.auth.padEnd(widths.auth)}  ${row.detail}`.trimEnd();
  return [line({ name: 'NAME', scope: 'SCOPE', transport: 'TRANSPORT', auth: 'AUTH', detail: 'DETAIL' }), ...rows.map(line)].join('\n');
};

type FolderRuntime = { client: RuntimeClient; folder: McpFolder };

const folderRuntime = async (ports: CliPorts, paths: MomongaPaths, signal: AbortSignal): Promise<FolderRuntime> => {
  await ensureCurrentDaemon(ports, paths, { signal });
  const client = connectRuntime(ports, paths);
  try {
    return { client, folder: { cwd: ports.cwd, env: await environmentSnapshot(ports, signal) } };
  } catch (error) {
    await client.close();
    throw error;
  }
};

export const mcpList = async (ports: CliPorts, paths: MomongaPaths, json: boolean): Promise<number> => {
  const { client, folder } = await folderRuntime(ports, paths, ports.interrupt);
  try {
    const servers = await client.folderMcpServers(folder);
    ports.stdout.write(`${json ? JSON.stringify(servers) : formatMcpServers(servers)}\n`);
    return 0;
  } finally {
    await client.close();
  }
};

export type McpLoginOptions = { openBrowser: boolean; interrupt: AbortSignal };

const settled = (view: McpAuthorizationView): McpAuthorizationView => {
  if (view.status === 'failed') {
    throw new McpLoginFailed(view.server, view.failure?.code ?? 'unknown', view.failure?.message ?? `the runtime gave no reason for the failed authorization of MCP server ${view.server}`);
  }
  return view;
};

export const mcpLogin = async (ports: CliPorts, paths: MomongaPaths, server: string, options: McpLoginOptions): Promise<number> => {
  const { client, folder } = await folderRuntime(ports, paths, options.interrupt);
  try {
    const started = settled(await client.startFolderMcpAuthorization(folder, server));
    if (started.status === 'completed') {
      ports.stdout.write(`${escapedLines([`MCP server ${server} is authorized`])}\n`);
      return 0;
    }
    if (started.url === undefined) throw new Error(`the runtime started the authorization of MCP server ${server} without an authorization URL`);
    ports.stdout.write(`${mcpAuthorizationInvitation(server, started.url)}\n`);
    let finished: McpAuthorizationView;
    const ended = new AbortController();
    try {
      if (options.openBrowser) {
        ports.openUrl(new URL(started.url), AbortSignal.any([options.interrupt, ended.signal]), (message) =>
          ports.stderr.write(`${escapedLines([browserNotOpenedLine(message)])}\n`),
        );
      }
      finished = await pollUntil(
        ports.clock,
        async () => {
          const view = await client.folderMcpAuthorization(folder.cwd, server);
          return view.status === 'awaiting_user' ? undefined : view;
        },
        {
          boundMs: Math.max(0, started.expiresAt - ports.clock.now()) + AUTHORIZATION_POLL_INTERVAL_MS,
          intervalMs: AUTHORIZATION_POLL_INTERVAL_MS,
          description: `the browser authorization of MCP server ${server}`,
          signal: options.interrupt,
        },
      );
    } catch (error) {
      await client.cancelFolderMcpAuthorization(folder.cwd, server);
      if (options.interrupt.aborted) {
        ports.stderr.write(`${escapedLines([cancelledLine(`authorization of MCP server ${server}`)])}\n`);
        return EXIT_INTERRUPTED;
      }
      throw error;
    } finally {
      ended.abort();
    }
    settled(finished);
    ports.stdout.write(`${escapedLines([`MCP server ${server} is authorized`])}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
