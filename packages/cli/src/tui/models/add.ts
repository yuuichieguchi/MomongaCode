import path from 'node:path';
import { baseUrlProblem, providerNameOf, serverNameFromCommand } from '@momonga/config';
import { LOCAL_SERVER_CANDIDATES, MANAGED_SERVERS, PROVIDER_NAME_PATTERN, canonOf, displayMapOf, managedServerOf, withDefaultTag } from '@momonga/protocol';
import type { ManagedServerDescription, DetectedLocalServer, DetectedModel, LocalServerDetection, ModelView } from '@momonga/protocol';
import { describeFailure } from '../../failure.ts';
import { wholeNumberWithin } from '../../models-check.ts';
import { addProposalOf, entryOf, foundProposalOf, foundRowOf, kindOf, nameInputOf, offeredServers, proposeForm } from '../../commands/models.ts';
import type { ModelsEdit, ModelsProposal } from '../../commands/models.ts';
import { NO_SERVER_ANSWERED_TEXT, noServerAnsweredAtText } from '../../models-texts.ts';
import { MEASURING_TEXT } from '../screen/waiting-row.tsx';
import { cancellable, chosenOf, confirmAndWrite, hostOf, openEdit, refusedSentence } from './context.ts';
import type { ModelsFlowContext, Opened } from './context.ts';
import {
  ADDRESS_PROMPT,
  allConfiguredText,
  ADD_TITLE,
  API_ROWS,
  BACK_ROW,
  KEY_ENV_PROBLEM,
  KEY_ENV_PROMPT,
  KEY_ENV_ROW,
  KEY_PROBLEM,
  KEY_PROMPT,
  KEY_SECRET_ROW,
  KEY_TITLE,
  MODEL_NAME_PROBLEM,
  MODEL_NAME_PROMPT,
  NAME_PROBLEM,
  NOT_AN_ADDRESS,
  NOT_A_FULL_PATH,
  PROGRAM_ARGUMENTS_PROMPT,
  PROGRAM_PATH_PROMPT,
  PROGRAM_ROW,
  READY_PATH_PROBLEM,
  READY_PATH_PROMPT,
  SAVING_KEY_PHASE,
  SEARCHING_PHASE,
  SEARCH_ROW,
  SERVICE_ADDRESS_PROMPT,
  SERVICE_API_ROWS,
  SERVICE_NAME_PROMPT,
  SERVICE_ROW,
  TYPE_ADDRESS_ROW,
  builtInServerRow,
  nameTakenText,
  programNamePrompt,
  windowPrompt,
  windowProblem,
} from './texts.ts';

export type Added = { readonly model: string | undefined };

const NOT_ADDED = undefined;

export const addressProblem = (text: string): string | undefined => {
  if (!URL.canParse(text.trim())) return NOT_AN_ADDRESS;
  const { protocol } = new URL(text.trim());
  if (protocol !== 'http:' && protocol !== 'https:') return NOT_AN_ADDRESS;
  return baseUrlProblem(text.trim(), false);
};

const wholeNumberIn = wholeNumberWithin;

export const askWindow = async (context: ModelsFlowContext, display: string, ceiling: number | undefined): Promise<number | undefined> => {
  const entered = await context.overlays.promptText({ title: windowPrompt(display, ceiling), validate: (text) => (wholeNumberIn(text, ceiling) === undefined ? windowProblem(ceiling) : undefined) });
  return entered === undefined ? undefined : wholeNumberIn(entered, ceiling);
};

const viewOf = (provider: string, id: string, defaultTag: string | undefined): ModelView => {
  const ownName = withDefaultTag(id, defaultTag);
  return { canon: canonOf(provider, ownName), provider, ownName, ...(defaultTag === undefined ? {} : { defaultTag }) };
};

const displaysWith = (edit: ModelsEdit, added: readonly ModelView[]): ReadonlyMap<string, string> => {
  const known = new Set(edit.resolved.views.map((view) => view.canon));
  return displayMapOf([...edit.resolved.views, ...added.filter((view) => !known.has(view.canon))]);
};

export const foundDisplays = (edit: ModelsEdit, server: DetectedLocalServer): string[] => {
  const { defaultTag } = kindOf(server);
  const views = server.models.map((model) => viewOf(server.provider, model.id, defaultTag));
  const displays = displaysWith(edit, views);
  return views.map((view) => displays.get(view.canon) ?? view.canon);
};

export type FoundModel = { readonly server: DetectedLocalServer; readonly model: DetectedModel; readonly display: string };

export const foundNotConfigured = (edit: ModelsEdit, servers: readonly DetectedLocalServer[]): FoundModel[] => {
  const configured = new Set(edit.resolved.views.map((view) => view.canon));
  return servers.flatMap((server) => {
    const { defaultTag } = kindOf(server);
    const displays = foundDisplays(edit, server);
    return server.models.flatMap((model, index) => (configured.has(viewOf(server.provider, model.id, defaultTag).canon) ? [] : [{ server, model, display: displays[index] ?? model.id }]));
  });
};

export const addFoundModel = async (context: ModelsFlowContext, opened: Opened, server: DetectedLocalServer, found: DetectedModel, display: string): Promise<Added | undefined> => {
  const model = await context.wait('reading this model', (signal) => hostOf(context, signal).describe(server, found, signal));
  const window = model.contextWindow ?? (await askWindow(context, display, model.ceiling));
  if (window === undefined) return NOT_ADDED;
  const proposal = await refusedSentence(context, async () => foundProposalOf(opened.edit, { args: [], options: { window: String(window) } }, server, model));
  if (proposal === undefined) return NOT_ADDED;
  const written = await confirmAndWrite(opened, context, proposal.value);
  return written === undefined ? NOT_ADDED : { model: written.model };
};

const addableOf = (edit: ModelsEdit, server: DetectedLocalServer): DetectedLocalServer => ({ ...server, models: foundNotConfigured(edit, [server]).map((found) => found.model) });

const addFromServer = async (context: ModelsFlowContext, opened: Opened, found: DetectedLocalServer): Promise<Added | undefined> => {
  const server = addableOf(opened.edit, found);
  if (server.models.length === 0) {
    context.info(allConfiguredText(server.provider, server.address));
    return NOT_ADDED;
  }
  const displays = await refusedSentence(context, async () => foundDisplays(opened.edit, server));
  if (displays === undefined) return NOT_ADDED;
  const index = await chosenOf(context, { title: foundRowOf(server), rows: displays.value.map((label) => ({ label })) });
  const model = index === undefined ? undefined : server.models[index];
  if (index === undefined || model === undefined) return NOT_ADDED;
  return addFoundModel(context, opened, server, model, displays.value[index] ?? model.id);
};

export const searchServers = async (context: ModelsFlowContext, typed: readonly string[]): Promise<readonly LocalServerDetection[] | undefined> => {
  const found = await cancellable(context, SEARCHING_PHASE, (signal) => hostOf(context, signal).detect({ candidates: typed.length === 0 ? LOCAL_SERVER_CANDIDATES : [], typed, signal }));
  if (found === undefined) return undefined;
  if (typed.length === 0) context.found.remember(offeredServers(found.value));
  return found.value;
};

const search = async (context: ModelsFlowContext, typed: readonly string[]): Promise<DetectedLocalServer[] | undefined> => {
  const found = await searchServers(context, typed);
  return found === undefined ? undefined : offeredServers(found);
};

const askModelName = (context: ModelsFlowContext): Promise<string | undefined> =>
  context.overlays.promptText({ title: MODEL_NAME_PROMPT, validate: (text) => (text.trim() === '' ? MODEL_NAME_PROBLEM : undefined) });

const addTyped = async (context: ModelsFlowContext, opened: Opened, connection: Record<string, unknown>, before?: () => Promise<void>): Promise<Added | undefined> => {
  const name = await askModelName(context);
  if (name === undefined) return NOT_ADDED;
  const id = name.trim();
  const provider = providerNameOf(nameInputOf(connection), opened.edit.ports.kinds);
  const view = viewOf(provider, id, undefined);
  const window = await askWindow(context, displaysWith(opened.edit, [view]).get(view.canon) ?? id, undefined);
  if (window === undefined) return NOT_ADDED;
  const written = await confirmAndWrite(opened, context, addProposalOf(opened.edit, connection, entryOf(id, window)), before);
  return written === undefined ? NOT_ADDED : { model: written.model };
};

const addUnanswered = async (context: ModelsFlowContext, opened: Opened, address: string): Promise<Added | undefined> => {
  const api = await chosenOf(context, { title: noServerAnsweredAtText(address), rows: API_ROWS.map((row) => ({ label: row.label })) });
  const row = api === undefined ? undefined : API_ROWS[api];
  return row === undefined ? NOT_ADDED : addTyped(context, opened, { adapter: row.adapter, baseUrl: address });
};

export const addFromFound = async (context: ModelsFlowContext, servers: readonly DetectedLocalServer[]): Promise<Added | undefined> => {
  const opened = await openEdit(context);
  const index = await chosenOf(context, { title: SEARCH_ROW, rows: servers.map((server) => ({ label: foundRowOf(addableOf(opened.edit, server)) })) });
  const server = index === undefined ? undefined : servers[index];
  return server === undefined ? NOT_ADDED : addFromServer(context, opened, server);
};

export const builtInRowOf = (server: Pick<ManagedServerDescription, 'label'>): string => builtInServerRow(server.label);

export const managedRowOf = (id: string): string => {
  const server = managedServerOf(MANAGED_SERVERS, id);
  if (server === undefined) throw new Error(`no managed server is described with the id ${id}`);
  return builtInRowOf(server);
};

export const addByAddress = async (context: ModelsFlowContext): Promise<Added | undefined> => {
  const typed = await context.overlays.promptText({ title: ADDRESS_PROMPT, validate: addressProblem });
  if (typed === undefined) return NOT_ADDED;
  const address = typed.trim();
  const servers = await search(context, [address]);
  if (servers === undefined) return NOT_ADDED;
  const opened = await openEdit(context);
  const [server] = servers;
  return server === undefined ? addUnanswered(context, opened, address) : addFromServer(context, opened, server);
};

export const addBySearch = async (context: ModelsFlowContext): Promise<Added | undefined> => {
  const servers = await search(context, []);
  if (servers === undefined) return NOT_ADDED;
  if (servers.length === 0) {
    const next = await chosenOf(context, { title: NO_SERVER_ANSWERED_TEXT, rows: [{ label: TYPE_ADDRESS_ROW }, { label: BACK_ROW }] });
    return next === 0 ? addByAddress(context) : NOT_ADDED;
  }
  return addFromFound(context, servers);
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SECRET_NAME_SUFFIX = '-api-key';

export type EnteredKey = { readonly kind: 'env'; readonly name: string } | { readonly kind: 'secret'; readonly value: string };

export const askKey = async (context: ModelsFlowContext): Promise<EnteredKey | undefined> => {
  const way = await chosenOf(context, { title: KEY_TITLE, rows: [{ label: KEY_ENV_ROW }, { label: KEY_SECRET_ROW }] });
  if (way === undefined) return undefined;
  if (way === 0) {
    const name = await context.overlays.promptText({ title: KEY_ENV_PROMPT, validate: (text) => (ENV_NAME.test(text.trim()) ? undefined : KEY_ENV_PROBLEM) });
    return name === undefined ? undefined : { kind: 'env', name: name.trim() };
  }
  const value = await context.overlays.promptText({ title: KEY_PROMPT, hidden: true, validate: (text) => (text === '' ? KEY_PROBLEM : undefined) });
  return value === undefined ? undefined : { kind: 'secret', value };
};

export const secretNameOf = (server: string): string => `${server}${SECRET_NAME_SUFFIX}`;

export const storeKey = (context: ModelsFlowContext, name: string, value: string): Promise<void> => context.wait(SAVING_KEY_PHASE, (signal) => context.backend.storeSecret(name, value, signal));

export const addService = async (context: ModelsFlowContext): Promise<Added | undefined> => {
  const api = await chosenOf(context, { title: SERVICE_ROW, rows: SERVICE_API_ROWS.map((row) => ({ label: row.label })) });
  const row = api === undefined ? undefined : SERVICE_API_ROWS[api];
  if (row === undefined) return NOT_ADDED;
  const typed = await context.overlays.promptText({ title: SERVICE_ADDRESS_PROMPT, validate: addressProblem });
  if (typed === undefined) return NOT_ADDED;
  const key = await askKey(context);
  if (key === undefined) return NOT_ADDED;
  const service = await context.overlays.promptText({ title: SERVICE_NAME_PROMPT, validate: (text) => (text.trim() === '' || PROVIDER_NAME_PATTERN.test(text.trim()) ? undefined : NAME_PROBLEM) });
  if (service === undefined) return NOT_ADDED;
  const opened = await openEdit(context);
  const base = { adapter: row.adapter, baseUrl: typed.trim(), ...(service.trim() === '' ? {} : { provider: service.trim() }) };
  if (key.kind === 'env') return addTyped(context, opened, { ...base, apiKeyEnv: key.name });
  const name = secretNameOf(providerNameOf(nameInputOf(base), opened.edit.ports.kinds));
  return addTyped(context, opened, { ...base, apiKeySecret: name }, () => storeKey(context, name, key.value));
};

const measured = async (context: ModelsFlowContext, work: (signal: AbortSignal) => Promise<ModelsProposal>): Promise<ModelsProposal | undefined> => {
  try {
    return (await cancellable(context, MEASURING_TEXT, work))?.value;
  } catch (error) {
    context.info(describeFailure(error));
    return undefined;
  }
};

export const addProgram = async (context: ModelsFlowContext): Promise<Added | undefined> => {
  const opened = await openEdit(context);
  const { platform } = opened.host;
  const isFullPath = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const command = await context.overlays.promptText({ title: PROGRAM_PATH_PROMPT, validate: (text) => (isFullPath(text.trim()) ? undefined : NOT_A_FULL_PATH) });
  if (command === undefined) return NOT_ADDED;
  const args = await context.overlays.promptText({ title: PROGRAM_ARGUMENTS_PROMPT, validate: () => undefined });
  if (args === undefined) return NOT_ADDED;
  const readyPath = await context.overlays.promptText({ title: READY_PATH_PROMPT, validate: (text) => (text.trim().startsWith('/') ? undefined : READY_PATH_PROBLEM) });
  if (readyPath === undefined) return NOT_ADDED;
  const taken = new Set([...opened.edit.resolved.connections.map((connection) => connection.provider), ...Object.keys(opened.edit.resolved.servers)]);
  const prefill = serverNameFromCommand(command.trim(), taken, platform);
  const typed = await context.overlays.promptText({
    title: programNamePrompt(prefill),
    validate: (text) => {
      const name = text.trim();
      if (name === '') return prefill === undefined ? NAME_PROBLEM : undefined;
      if (!PROVIDER_NAME_PATTERN.test(name)) return NAME_PROBLEM;
      return taken.has(name) ? nameTakenText(name) : undefined;
    },
  });
  if (typed === undefined) return NOT_ADDED;
  const name = typed.trim() === '' ? prefill : typed.trim();
  if (name === undefined) return NOT_ADDED;
  const options = { command: command.trim(), readyPath: readyPath.trim(), arg: args.split(/\s+/).filter((part) => part !== ''), name };
  const proposal = await measured(context, (signal) => proposeForm(hostOf(context, signal), opened.edit, 'add-program', { args: [], options }));
  if (proposal === undefined) return NOT_ADDED;
  const written = await confirmAndWrite(opened, context, proposal);
  return written === undefined ? NOT_ADDED : { model: written.model };
};

export const addBuiltIn = async (context: ModelsFlowContext, id: string): Promise<Added | undefined> => {
  const opened = await openEdit(context);
  const proposal = await measured(context, async (signal) => addProposalOf(opened.edit, { adapter: 'managed', server: id }, { id: await hostOf(context, signal).programModel({ id, builtIn: true }, signal) }));
  if (proposal === undefined) return NOT_ADDED;
  const written = await confirmAndWrite(opened, context, proposal);
  return written === undefined ? NOT_ADDED : { model: written.model };
};

export const unusedBuiltIns = (edit: ModelsEdit): string[] => MANAGED_SERVERS.map((server) => server.id).filter((id) => !edit.resolved.connections.some((connection) => connection.server === id));

type AddRow = { label: string; act(): Promise<Added | undefined> };

export const addRows = (context: ModelsFlowContext, edit: ModelsEdit): AddRow[] => [
  { label: SEARCH_ROW, act: () => addBySearch(context) },
  { label: TYPE_ADDRESS_ROW, act: () => addByAddress(context) },
  { label: SERVICE_ROW, act: () => addService(context) },
  { label: PROGRAM_ROW, act: () => addProgram(context) },
  ...unusedBuiltIns(edit).map((id) => ({ label: managedRowOf(id), act: () => addBuiltIn(context, id) })),
];

export const runAddFlow = async (context: ModelsFlowContext): Promise<Added | undefined> => {
  const { edit } = await openEdit(context);
  const rows = addRows(context, edit);
  const index = await chosenOf(context, { title: ADD_TITLE, rows: rows.map((row) => ({ label: row.label })) });
  const row = index === undefined ? undefined : rows[index];
  return row === undefined ? NOT_ADDED : row.act();
};
