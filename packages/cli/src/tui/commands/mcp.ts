import { mcpServerNameProblem } from '@momonga/config';
import type { McpServerView } from '@momonga/protocol';
import { APPLIES_NEXT_SESSION, confirmed, writeSetting } from '../settings-screen.tsx';
import type { Refusal } from '../settings-screen.tsx';
import { NEEDS_SESSION_NOTE } from '../slash.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';
import { shellFormOf } from './shell-commands.ts';

export const MCP_TITLE = 'MCP servers';
export const ADD_STDIO_ROW = 'Add a stdio server';
export const ADD_HTTP_ROW = 'Add an http server';
export const PROJECT_SERVER_ACTIONS = ['Enable', 'Disable'] as const;
export const MCP_NAME_TITLE = 'Name of the server';
export const MCP_COMMAND_TITLE = 'Command';
export const MCP_ARGUMENTS_TITLE = 'Arguments, separated by spaces (empty: none)';
export const MCP_ENVIRONMENT_TITLE = 'Names of the environment variables it is given, separated by spaces (empty: none)';
export const MCP_ADDRESS_TITLE = 'Address';

export const sessionServerNote = (name: string): string => `${name} belongs to this session and is in no settings file`;

export const mcpServerLine = (server: McpServerView): string => [server.name, server.scope, server.transport, server.auth, ...(server.url === undefined ? [] : [server.url]), ...(server.detail === undefined ? [] : [server.detail])].join('  ');

const needed = (what: string) => (text: string): string | undefined => (text.trim() === '' ? `expected ${what}` : undefined);

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '');

const strings = (current: unknown): string[] => (Array.isArray(current) ? (current as unknown[]).filter((member): member is string => typeof member === 'string') : []);

const withName = (name: string) => (current: unknown): unknown => (strings(current).includes(name) ? current : [...strings(current), name]);

const withoutName = (name: string) => (current: unknown): unknown => {
  const next = strings(current).filter((member) => member !== name);
  return next.length === 0 ? undefined : next;
};

const addServer = (context: SlashContext, name: string, server: Readonly<Record<string, unknown>>): Promise<Refusal | undefined> => writeSetting(context, 'user', { kind: 'set', path: ['mcpServers', name], value: server });

const addStdio = async (context: SlashContext): Promise<Refusal | 'left' | undefined> => {
  const { promptText } = context.overlays;
  const name = await promptText({ title: MCP_NAME_TITLE, validate: mcpServerNameProblem });
  if (name === undefined) return 'left';
  const command = await promptText({ title: MCP_COMMAND_TITLE, validate: needed('a command') });
  if (command === undefined) return 'left';
  const args = await promptText({ title: MCP_ARGUMENTS_TITLE, validate: () => undefined });
  if (args === undefined) return 'left';
  const environment = await promptText({ title: MCP_ENVIRONMENT_TITLE, validate: () => undefined });
  if (environment === undefined) return 'left';
  const names = words(environment);
  return addServer(context, name, {
    type: 'stdio',
    command,
    ...(words(args).length === 0 ? {} : { args: words(args) }),
    ...(names.length === 0 ? {} : { env: Object.fromEntries(names.map((variable) => [variable, `\${${variable}}`])) }),
  });
};

const addHttp = async (context: SlashContext): Promise<Refusal | 'left' | undefined> => {
  const { promptText } = context.overlays;
  const name = await promptText({ title: MCP_NAME_TITLE, validate: mcpServerNameProblem });
  if (name === undefined) return 'left';
  const url = await promptText({ title: MCP_ADDRESS_TITLE, validate: needed('an address') });
  if (url === undefined) return 'left';
  return addServer(context, name, { type: 'http', url });
};

const switchProjectServer = async (context: SlashContext, server: McpServerView): Promise<Refusal | 'left' | undefined> => {
  const choice = await context.overlays.choose({ title: server.name, rows: PROJECT_SERVER_ACTIONS.map((label) => ({ label })), decideOn: 'enter', escape: 'back', filter: false });
  if (choice === undefined) return 'left';
  const enable = PROJECT_SERVER_ACTIONS[choice.index] === 'Enable';
  const [joined, left] = enable ? ['enabledMcpjsonServers', 'disabledMcpjsonServers'] : ['disabledMcpjsonServers', 'enabledMcpjsonServers'];
  const refusal = await writeSetting(context, 'user', { kind: 'update', path: [left], update: withoutName(server.name) });
  return refusal ?? writeSetting(context, 'user', { kind: 'update', path: [joined], update: withName(server.name) });
};

const actOnServer = async (context: SlashContext, server: McpServerView): Promise<Refusal | 'left' | undefined> => {
  if (server.scope === 'project') return switchProjectServer(context, server);
  if (server.scope === 'session') {
    context.info(sessionServerNote(server.name));
    return 'left';
  }
  if (!(await confirmed(context, `Remove ${server.name}?`))) return 'left';
  return writeSetting(context, 'user', { kind: 'unset', path: ['mcpServers', server.name] });
};

const shellForm = shellFormOf('mcp');

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  usage: `[${shellForm.usage ?? ''}]`,
  description: `show the MCP servers with their status, add or remove one, and enable or disable a server of the project; with words: ${shellForm.description}`,
  needsSession: false,
  run: async (args, context) => {
    if (args !== '') {
      await shellForm.run(args, context);
      return;
    }
    if (context.model === undefined) {
      context.info(NEEDS_SESSION_NOTE);
      return;
    }
    let at = 0;
    let line: string | undefined;
    for (;;) {
      const servers = await context.backend.mcpServers();
      const choice = await context.overlays.choose({
        title: MCP_TITLE,
        lines: line === undefined ? [] : [line],
        rows: [...servers.map((server) => ({ label: mcpServerLine(server) })), { label: ADD_STDIO_ROW }, { label: ADD_HTTP_ROW }],
        initial: Math.min(at, servers.length + 1),
        decideOn: 'enter',
        escape: 'back',
        filter: false,
      });
      if (choice === undefined) return;
      at = choice.index;
      const server = servers[choice.index];
      const result = server !== undefined ? await actOnServer(context, server) : choice.index === servers.length ? await addStdio(context) : await addHttp(context);
      line = result === 'left' ? undefined : result === undefined ? APPLIES_NEXT_SESSION : result.refused;
    }
  },
};
