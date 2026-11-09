import type { MomongaPaths } from '@momonga/foundation';
import { escapeTerminalLine } from '@momonga/protocol';
import type { McpAuthorizationView, McpServerView } from '@momonga/protocol';
import { AUTHORIZATION_POLL_INTERVAL_MS } from '../constants.ts';
import { mcpLoginCommand } from '../mcp/messages.ts';
import { pollUntil } from '../poll.ts';
import type { CliPorts } from '../ports.ts';
import { openSession } from '../run/open-session.ts';
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

const EXIT_INTERRUPTED = 130;

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

export const mcpList = async (ports: CliPorts, paths: MomongaPaths, json: boolean): Promise<number> => {
  const session = await openSession(ports, paths, {});
  try {
    const servers = await session.client.mcpServers(session.created.session.id);
    ports.stdout.write(`${json ? JSON.stringify(servers) : formatMcpServers(servers)}\n`);
    return 0;
  } finally {
    await session.close();
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
  const session = await openSession(ports, paths, {});
  const sessionId = session.created.session.id;
  try {
    const started = settled(await session.client.startMcpAuthorization(sessionId, server));
    if (started.status === 'completed') {
      ports.stdout.write(`${escapedLines([`MCP server ${server} is authorized`])}\n`);
      return 0;
    }
    if (started.url === undefined) throw new Error(`the runtime started the authorization of MCP server ${server} without an authorization URL`);
    ports.stdout.write(`${mcpAuthorizationInvitation(server, started.url)}\n`);
    let finished: McpAuthorizationView;
    try {
      if (options.openBrowser) await ports.openUrl(new URL(started.url), options.interrupt);
      finished = await pollUntil(
        ports.clock,
        async () => {
          const view = await session.client.mcpAuthorization(sessionId, server);
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
      await session.client.cancelMcpAuthorization(sessionId, server);
      if (options.interrupt.aborted) {
        ports.stderr.write(`${escapedLines([`momonga: authorization of MCP server ${server} cancelled`])}\n`);
        return EXIT_INTERRUPTED;
      }
      throw error;
    }
    settled(finished);
    ports.stdout.write(`${escapedLines([`MCP server ${server} is authorized`])}\n`);
    return 0;
  } finally {
    await session.close();
  }
};
