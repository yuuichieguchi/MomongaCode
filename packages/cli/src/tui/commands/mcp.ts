import { mcpServerNameProblem } from '@momonga/config';
import type { McpServerView } from '@momonga/protocol';
import { APPLIES_NEXT_SESSION, SAVE_TO_TITLE, confirmed, savedOrRefused, writeSetting } from '../settings-screen.tsx';
import type { Refusal } from '../settings-screen.tsx';
import { chooseThen } from '../flow-step.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';
import { shellFormOf } from './shell-commands.ts';
import { askTrustItems } from '../project-items.ts';

export const MCP_TITLE = 'MCP servers';
export const ADD_STDIO_ROW = 'Add a stdio server';
export const ADD_HTTP_ROW = 'Add an http server';
export const PROJECT_SERVER_ACTIONS = ['Enable', 'Disable'] as const;
export const MCP_NAME_TITLE = 'Name of the server';
export const MCP_COMMAND_TITLE = 'Command';
export const MCP_ARGUMENTS_TITLE = 'Arguments, separated by spaces (empty: none)';
export const MCP_ENVIRONMENT_TITLE = 'Names of the environment variables it is given, separated by spaces (empty: none)';
export const MCP_SECRETS_TITLE = 'Secrets of the secret store it is given, as NAME=secret-name separated by spaces (momonga secret set; empty: none)';
export const MCP_ADDRESS_TITLE = 'Address';

export const APPROVING_SERVER = 'recording the approval';

export const sessionServerNote = (name: string): string => `${name} belongs to this session and is in no settings file`;

export const mcpServerLine = (server: McpServerView): string => [server.name, server.scope, server.transport, server.auth, ...(server.url === undefined ? [] : [server.url]), ...(server.detail === undefined ? [] : [server.detail])].join('  ');

const needed = (what: string) => (text: string): string | undefined => (text.trim() === '' ? `expected ${what}` : undefined);

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '');

const SECRET_ENTRY = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;

const secretsProblem = (text: string): string | undefined => {
  const wrong = words(text).find((word) => !SECRET_ENTRY.test(word));
  return wrong === undefined ? undefined : `expected NAME=secret-name, got ${JSON.stringify(wrong)}`;
};

const secretEnvOf = (text: string): Record<string, string> => Object.fromEntries(words(text).map((word) => SECRET_ENTRY.exec(word)?.slice(1, 3) ?? []));

const entries = (current: unknown): unknown[] => (Array.isArray(current) ? (current as unknown[]) : []);

const namesEntry = (name: string) => (member: unknown): boolean => member === name || (typeof member === 'object' && member !== null && (member as Record<string, unknown>)['name'] === name);

const withEntry = (name: string, entry: unknown) => (current: unknown): unknown => [...entries(current).filter((member) => !namesEntry(name)(member)), entry];

const withoutName = (name: string) => (current: unknown): unknown => {
  const next = entries(current).filter((member) => !namesEntry(name)(member));
  return next.length === 0 ? undefined : next;
};

const serverPlaceOf = async (context: SlashContext): Promise<'user' | 'project' | undefined> => {
  const places = (await context.backend.settings()).targets.filter((layer) => layer !== 'local');
  if (places.length < 2) return 'user';
  const choice = await context.overlays.choose({ title: SAVE_TO_TITLE, rows: places.map((label) => ({ label })), initial: 0, decideOn: 'enter', escape: 'back', filter: false });
  return choice === undefined ? undefined : places[choice.index] === 'project' ? 'project' : 'user';
};

const addServer = async (context: SlashContext, name: string, server: Readonly<Record<string, unknown>>): Promise<Refusal | 'left' | undefined> => {
  const place = await serverPlaceOf(context);
  if (place === undefined) return 'left';
  if (place === 'project') return savedOrRefused(context, (signal) => context.backend.writeProjectMcpServer(name, server, signal));
  return writeSetting(context, 'user', { kind: 'set', path: ['mcpServers', name], value: server });
};

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
  const secrets = await promptText({ title: MCP_SECRETS_TITLE, validate: secretsProblem });
  if (secrets === undefined) return 'left';
  const names = words(environment);
  const secretEnv = secretEnvOf(secrets);
  return addServer(context, name, {
    type: 'stdio',
    command,
    ...(words(args).length === 0 ? {} : { args: words(args) }),
    ...(names.length === 0 ? {} : { env: Object.fromEntries(names.map((variable) => [variable, `\${${variable}}`])) }),
    ...(Object.keys(secretEnv).length === 0 ? {} : { secretEnv }),
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
  if (PROJECT_SERVER_ACTIONS[choice.index] === 'Enable') {
    for (;;) {
      const item = (await context.backend.trustItems(server.name)).items.find((pending) => pending.kind === 'mcp' && pending.name === server.name);
      if (item === undefined) return undefined;
      const [approved] = await askTrustItems([item], context.overlays.choose);
      if (approved === undefined) return 'left';
      const current = await context.backend.pendingProjectServer(server.name);
      if (current?.digest !== approved.digest) continue;
      await context.background(APPROVING_SERVER, () => context.backend.approveProjectItems([approved]));
      return undefined;
    }
  }
  const refusal = await writeSetting(context, 'user', { kind: 'update', path: ['enabledMcpjsonServers'], update: withoutName(server.name) });
  return refusal ?? writeSetting(context, 'user', { kind: 'update', path: ['disabledMcpjsonServers'], update: withEntry(server.name, server.name) });
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
  ...(shellForm.subcommands === undefined ? {} : { subcommands: shellForm.subcommands }),
  needsSession: false,
  run: async (args, context) => {
    if (args !== '') {
      await shellForm.run(args, context);
      return;
    }
    let at = 0;
    let line: string | undefined;
    for (;;) {
      const servers = context.model === undefined ? await context.backend.folderMcpServers() : await context.backend.mcpServers();
      const acted = await chooseThen(
        context.overlays.choose,
        () => ({
          title: MCP_TITLE,
          lines: line === undefined ? [] : [line],
          rows: [...servers.map((server) => ({ label: mcpServerLine(server) })), { label: ADD_STDIO_ROW }, { label: ADD_HTTP_ROW }],
          initial: Math.min(at, servers.length + 1),
          decideOn: 'enter',
          escape: 'back',
          filter: false,
        }),
        async (choice) => {
          at = choice.index;
          const server = servers[choice.index];
          return server !== undefined ? actOnServer(context, server) : choice.index === servers.length ? addStdio(context) : addHttp(context);
        },
      );
      if (acted === undefined) return;
      const result = acted.value;
      line = result === 'left' ? undefined : result === undefined ? APPLIES_NEXT_SESSION : result.refused;
    }
  },
};
