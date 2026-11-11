import { ModelsEditRefused, durationText, editModelsSettings, fieldLabel, fieldValueText, loadUserModels, loadUserSettings, planModelsEdit, providerNameOf, registeredServer, serverKindOf, serverNameFromCommand, serverRegistryOf, settableFieldPath } from '@momonga/config';
import type { ConnectionDraft, ModelEntry, ModelsEditPlan, ModelsEditPorts, ModelsOperation, ModelsOperations, ModelsReference, ProviderNameInput, ResolvedModels } from '@momonga/config';
import { EXIT_FAILURE, EXIT_USAGE, createBinaryHashCache, currentSocketResolver, isRecord, parseOutsideJson } from '@momonga/foundation';
import type { MomongaPaths, OutboundFetch } from '@momonga/foundation';
import {
  GENERIC_SERVER_KIND,
  LOCAL_SERVER_CANDIDATES,
  MODEL_NOT_LISTED_CODE,
  ModelRefError,
  SERVER_KINDS,
  TARGET_BILLINGS,
  agentReadiness,
  canonOf,
  displayMapOf,
  isNotListedCapabilities,
  isUnavailableCapabilities,
  maxOutputTokensFor,
  modelRefErrorOf,
  resolveTypedModelRef,
  serverCountText,
  typedModelText,
  withDefaultTag,
} from '@momonga/protocol';
import type { DetectedLocalServer, DetectedManagedServer, DetectedModel, LocalServerDetection, ModelView, ModelViews, MomongaModelEntry, MomongaModelList, MomongaModelRoles, PlanAccountView, PlanCatalogEntry, Readiness, ServerKind, ServerKindAdapter, TargetBilling } from '@momonga/protocol';
import { createGatewayClient, listingViewsOf } from '../client/gateway-client.ts';
import type { PlanGatewayClient } from '../client/gateway-client.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import { formatTokens } from '../format-tokens.ts';
import { localManagedPorts } from '../local-managed-ports.ts';
import { NOT_LISTED_BY_SERVER_MARK, NO_SERVER_ANSWERED_TEXT, RUN_AGAIN_WITH_YES_TEXT, noModelsText, noServerAnsweredAtText, notListedByServerText } from '../models-texts.ts';
import { withIdentityReadFetch } from '../network.ts';
import { announcePlainHttp } from '../plain-http.ts';
import type { CliFiles, CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';
import { cliProbeInstance } from './gateway.ts';

type Writer = { write(text: string): void };

export type DetectRequest = { candidates: readonly string[]; typed: readonly string[]; signal: AbortSignal };

export type DeclaredProgram = { id: string; command: string; args: readonly string[]; readyPath: string };

export type BuiltInProgram = { id: string; builtIn: true };

export type ServerProgram = DeclaredProgram | BuiltInProgram;

export type ModelsShell = {
  stdout: Writer;
  stderr: Writer;
  home: string;
  settingsFile: string;
  platform: NodeJS.Platform;
  interrupt: AbortSignal;
  files: Pick<CliFiles, 'readText' | 'readTextIfPresent'>;
  listing(): Promise<MomongaModelList>;
  detect(request: DetectRequest): Promise<readonly LocalServerDetection[]>;
  programModel(program: ServerProgram, signal: AbortSignal): Promise<string>;
};

export type ModelsHost = Omit<ModelsShell, 'stdout' | 'stderr'>;

export const SEPARATOR = '  ·  ';
const ROW_INDENT = '  ';
export const START_MARK = 'starts new sessions';
const WINDOW_NOT_KNOWN = 'window not known';
export const SESSION_MODEL_TEXT = "the session's model";

const print = (writer: Writer, lines: readonly string[]): void => writer.write(`${escapedLines(lines)}\n`);

type Print = (lines: readonly string[]) => void;

export const listedModelOf = (entries: readonly MomongaModelEntry[], text: string): string => {
  const views = listingViewsOf(entries);
  const resolution = resolveTypedModelRef(typedModelText(text), views);
  if (resolution.kind !== 'found') throw modelRefErrorOf(text, resolution, views, 'cli');
  return resolution.model.canon;
};

export type ListedModel = {
  model: string;
  name: string;
  provider: string;
  address: string | null;
  billing: TargetBilling;
  contextWindow: number | null;
  fallback: string[];
  state: Readiness['state'];
  code?: string;
  message?: string;
};

export type ModelsDocument = { start: string | null; roles: MomongaModelRoles; models: ListedModel[] };

export const addressesOf = (resolved: ResolvedModels): ReadonlyMap<string, string> =>
  new Map(resolved.connections.flatMap((connection): [string, string][] => (connection.baseUrl === undefined || connection.plan !== undefined ? [] : [[connection.provider, connection.baseUrl]])));

const stateOf = (entry: MomongaModelEntry, name: string, notListed: boolean): Pick<ListedModel, 'state' | 'code' | 'message'> => {
  if (notListed) return { state: 'unavailable', code: MODEL_NOT_LISTED_CODE, message: notListedByServerText(name, entry.ownName) };
  const { capabilities } = entry;
  if (isUnavailableCapabilities(capabilities)) return { state: 'unavailable', code: capabilities.toolCalling.code, message: capabilities.toolCalling.message };
  return { state: agentReadiness(capabilities).state };
};

export const modelsDocumentOf = (listing: MomongaModelList, addresses: ReadonlyMap<string, string>, notListed: ReadonlySet<string>): ModelsDocument => {
  const displays = displayMapOf(listingViewsOf(listing.data));
  const models = listing.data.map((entry): ListedModel => {
    const name = displays.get(entry.id) ?? entry.id;
    return {
      model: entry.id,
      name,
      provider: entry.provider,
      address: addresses.get(entry.provider) ?? null,
      billing: entry.billing,
      contextWindow: isNotListedCapabilities(entry.capabilities) ? null : entry.capabilities.contextWindow,
      fallback: entry.chain.slice(1).map((member) => member.model),
      ...stateOf(entry, name, notListed.has(entry.id)),
    };
  });
  return { start: listing.start, roles: listing.roles, models };
};

const windowPartsOf = (model: ListedModel): string[] => {
  if (model.billing === 'plan') return [model.billing];
  return model.contextWindow === null ? [WINDOW_NOT_KNOWN] : [`${formatTokens(model.contextWindow)} tokens`, model.billing];
};

export const modelRowOf = (model: ListedModel, start: string | null): string =>
  `${ROW_INDENT}${[model.name, ...windowPartsOf(model), ...(model.model === start ? [START_MARK] : []), ...(model.code === MODEL_NOT_LISTED_CODE ? [NOT_LISTED_BY_SERVER_MARK] : [])].join(SEPARATOR)}`;

const modelLinesOf = (document: ModelsDocument): string[] => {
  if (document.models.length === 0) return [noModelsText()];
  const providers = [...new Set(document.models.map((model) => model.provider))];
  return providers.flatMap((provider) => {
    const served = document.models.filter((model) => model.provider === provider);
    const address = served[0]?.address ?? null;
    return [address === null ? provider : `${provider}${SEPARATOR}${address}`, ...served.map((model) => modelRowOf(model, document.start))];
  });
};

export const formatModels = (document: ModelsDocument): string => escapedLines(modelLinesOf(document));

const printDocument = (shell: ModelsShell, document: ModelsDocument, json: boolean): void => {
  if (json) shell.stdout.write(`${JSON.stringify(document)}\n`);
  else shell.stdout.write(`${formatModels(document)}\n`);
};

export const listModels = async (shell: ModelsShell, options: { json: boolean }): Promise<number> => {
  const listing = await shell.listing();
  const { resolved } = loadUserModels({ home: shell.home });
  announcePlainHttp(shell, resolved.plainHttp);
  printDocument(shell, modelsDocumentOf(listing, addressesOf(resolved), new Set()), options.json);
  return 0;
};

export const isLocalServer = (server: LocalServerDetection): server is DetectedLocalServer => 'kind' in server;

export const offeredServers = (found: readonly LocalServerDetection[]): DetectedLocalServer[] => found.filter(isLocalServer).filter((server) => server.models.length > 0);

export const notListedOf = async (shell: ModelsHost, resolved: ResolvedModels): Promise<ReadonlySet<string>> => {
  const configured = [...resolved.models.values()];
  const asked = await Promise.all(
    [...addressesOf(resolved)].map(async ([provider, address]) => {
      const answered = (await shell.detect({ candidates: [], typed: [address], signal: shell.interrupt })).filter(isLocalServer);
      if (answered.length === 0) return [];
      const listed = new Set(answered.flatMap((server) => server.models.map((model) => model.id)));
      return configured.filter((model) => model.provider === provider && !listed.has(model.ownName)).map((model) => model.canon);
    }),
  );
  return new Set(asked.flat());
};

export const checkModels = async (shell: ModelsShell, options: { json: boolean }): Promise<number> => {
  const listing = await shell.listing();
  const { resolved } = loadUserModels({ home: shell.home });
  announcePlainHttp(shell, resolved.plainHttp);
  printDocument(shell, modelsDocumentOf(listing, addressesOf(resolved), await notListedOf(shell, resolved)), options.json);
  return 0;
};

const detectedModelOf = (model: DetectedModel) => ({
  id: model.id,
  ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  ...(model.ceiling === undefined ? {} : { ceiling: model.ceiling }),
  tools: model.tools,
});

const managedLinesOf = (server: DetectedManagedServer): string[] => [
  `found the managed server ${server.id} at ${server.binary}`,
  ...(server.refused === undefined ? [] : [`${ROW_INDENT}${server.refused.message}${server.refused.remedy === undefined ? '' : ` (${server.refused.remedy})`}`]),
];

export const detectModels = async (shell: ModelsShell, options: { typed: readonly string[]; json: boolean }): Promise<number> => {
  const found = await shell.detect({ candidates: LOCAL_SERVER_CANDIDATES, typed: options.typed, signal: shell.interrupt });
  const servers = offeredServers(found);
  const managed = found.filter((server): server is DetectedManagedServer => !isLocalServer(server));
  if (options.json) {
    shell.stdout.write(`${JSON.stringify({ servers: servers.map((server) => ({ kind: server.kind, provider: server.provider, address: server.address, models: server.models.map(detectedModelOf) })), managed })}\n`);
    return 0;
  }
  print(shell.stdout, [
    ...(servers.length === 0 ? [NO_SERVER_ANSWERED_TEXT] : servers.flatMap((server) => [`${server.provider}${SEPARATOR}${server.address}`, ...server.models.map((model) => `${ROW_INDENT}${model.id}`)])),
    ...managed.flatMap(managedLinesOf),
  ]);
  return 0;
};

export type CatalogPorts = { stdout: Writer; stderr: Writer; plan: PlanGatewayClient };

const catalogAccount = async (ports: CatalogPorts, account: string | undefined): Promise<PlanAccountView | undefined> => {
  const listed = await ports.plan.accounts();
  const candidates = account === undefined ? listed.accounts.filter((entry) => entry.active) : listed.accounts.filter((entry) => entry.label === account);
  const [only, ...others] = candidates;
  if (only !== undefined && others.length === 0) return only;
  print(ports.stderr, [
    only === undefined
      ? account === undefined
        ? 'no signed-in account has a model list; sign in with momonga auth login'
        : `no saved account is labelled ${JSON.stringify(account)}; momonga auth status lists them`
      : `several accounts could answer (${candidates.map((entry) => `${entry.label} of ${entry.profile}`).join(', ')}); name the account`,
  ]);
  return undefined;
};

const catalogRow = (entry: PlanCatalogEntry): string =>
  entry.usable ? `${entry.slug}  ${entry.displayName}  context ${entry.contextWindow}  max output ${entry.maxOutputTokens}` : `${entry.slug}  ${entry.displayName}  unusable: ${entry.reason}`;

export const modelsCatalog = async (ports: CatalogPorts, options: { json: boolean; account?: string }): Promise<number> => {
  const account = await catalogAccount(ports, options.account);
  if (account === undefined) return EXIT_USAGE;
  const catalog = await ports.plan.accountModels(account.label, { profile: account.profile, refresh: true });
  ports.stdout.write(`${options.json ? JSON.stringify(catalog) : escapedLines(catalog.models.map(catalogRow))}\n`);
  return 0;
};

export const MODELS_FORMS = [
  'add',
  'remove',
  'remove-server',
  'start',
  'fallback list',
  'fallback add',
  'fallback remove',
  'fallback move',
  'billing list',
  'billing allow',
  'billing forbid',
  'role list',
  'role set',
  'role clear',
  'set',
  'unset',
  'set-server',
  'unset-server',
  'name',
  'add-program',
  'set-program',
  'forget-program',
  'timeouts',
  'dialects show',
  'dialects set',
] as const;

export type ModelsForm = (typeof MODELS_FORMS)[number];

export type FormOption = string | boolean | readonly string[] | undefined;

export type FormInput = { args: readonly string[]; options: Readonly<Record<string, FormOption>> };

class UsageError extends Error {}

export class ShellRefusal extends Error {}

type Json = Record<string, unknown>;

export type ModelsEdit = { document: Json; resolved: ResolvedModels; displays: ReadonlyMap<string, string>; ports: ModelsEditPorts };

export type AcceptedPlan = Exclude<ModelsEditPlan, { refused: unknown }>;

export type ModelsProposal = { operations: ModelsOperations; confirm(plan: AcceptedPlan): string };

export const modelsEditOf = async (shell: ModelsHost): Promise<ModelsEdit> => {
  const text = await shell.files.readTextIfPresent(shell.settingsFile);
  const document: unknown = text === undefined ? {} : parseOutsideJson(text);
  if (!isRecord(document)) throw new ShellRefusal(`${shell.settingsFile}: settings must be a JSON object`);
  const { resolved } = loadUserModels({ home: shell.home });
  return { document, resolved, displays: displayMapOf(resolved.views), ports: { kinds: SERVER_KINDS, home: shell.home } };
};

export const displayIn = (edit: ModelsEdit, canon: string): string => edit.displays.get(canon) ?? canon;

const canonOfTyped = (edit: ModelsEdit, text: string): string => {
  const resolution = resolveTypedModelRef(typedModelText(text), edit.resolved.views);
  if (resolution.kind !== 'found') throw modelRefErrorOf(text, resolution, edit.resolved.views, 'cli');
  return resolution.model.canon;
};

const argument = (input: FormInput, index: number): string => {
  const value = input.args[index];
  if (value === undefined || value === '') throw new UsageError();
  return value;
};

const optionText = (input: FormInput, name: string): string | undefined => {
  const value = input.options[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

const requiredOption = (input: FormInput, name: string): string => {
  const value = optionText(input, name);
  if (value === undefined) throw new UsageError();
  return value;
};

const optionList = (input: FormInput, name: string): readonly string[] => {
  const value = input.options[name];
  return Array.isArray(value) ? value : [];
};

const wholeNumber = (text: string, minimum: number): number => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < minimum) throw new UsageError();
  return value;
};

export const connectionsOf = (document: Json): Json[] => {
  const models = document['models'];
  const connections = isRecord(models) ? models['connections'] : undefined;
  return Array.isArray(connections) ? connections.filter(isRecord) : [];
};

export const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const nameInputOf = (connection: Json): ProviderNameInput => {
  const plan = connection['plan'];
  return {
    adapter: String(connection['adapter']),
    provider: textOf(connection['provider']),
    baseUrl: textOf(connection['baseUrl']),
    socketPath: textOf(connection['socketPath']),
    server: textOf(connection['server']),
    plan: isRecord(plan) && typeof plan['profile'] === 'string' ? { profile: plan['profile'], account: textOf(plan['account']) } : undefined,
  };
};

export const viewsOfDocument = (document: Json, ports: ModelsEditPorts): ModelViews =>
  connectionsOf(document).flatMap((connection) => {
    const provider = providerNameOf(nameInputOf(connection), ports.kinds);
    const defaultTag = serverKindOf({ adapter: String(connection['adapter']) }, ports.kinds)?.defaultTag;
    const entries = Array.isArray(connection['models']) ? connection['models'].filter(isRecord) : [];
    return entries.map((entry): ModelView => {
      const ownName = withDefaultTag(String(entry['id']), defaultTag);
      return { canon: canonOf(provider, ownName), provider, ownName, ...(defaultTag === undefined ? {} : { defaultTag }) };
    });
  });

export const addedDisplayOf = (edit: ModelsEdit, plan: AcceptedPlan): string => {
  if (plan.model === undefined) throw new TypeError('the plan of an added model names no model');
  return displayMapOf(viewsOfDocument(plan.document, edit.ports)).get(plan.model) ?? plan.model;
};

export const JOB_WORDS: Readonly<Record<string, string>> = { compaction: 'summaries', reflection: 'reflection', analysis: 'analysis', classifier: 'the auto-mode classifier' };

const referenceWordOf = (reference: ModelsReference): string => {
  switch (reference.kind) {
    case 'start':
      return 'new sessions';
    case 'fallback':
      return `fallback position ${reference.position}`;
    case 'role':
      return JOB_WORDS[reference.job ?? ''] ?? String(reference.job);
    case 'classifier':
      return 'the auto-mode classifier';
    case 'billing':
      return 'a billing rule';
  }
};

export const referenceList = (references: readonly ModelsReference[]): string => [...new Set(references.map(referenceWordOf))].join(', ');

const alsoModelFor = (references: readonly ModelsReference[]): string => (references.length === 0 ? '' : ` It is also the model for: ${referenceList(references)}.`);

const API_ADAPTERS: Readonly<Record<string, ServerKindAdapter>> = { ollama: 'ollama', openai: 'chat-completions', anthropic: 'anthropic', responses: 'open-responses' };

const adapterOfApi = (api: string): ServerKindAdapter => {
  const adapter = Object.hasOwn(API_ADAPTERS, api) ? API_ADAPTERS[api] : undefined;
  if (adapter === undefined) throw new UsageError();
  return adapter;
};

const keyReferenceOf = (input: FormInput): Json => {
  const env = optionText(input, 'apiKeyEnv');
  const secret = optionText(input, 'apiKeySecret');
  return { ...(env === undefined ? {} : { apiKeyEnv: env }), ...(secret === undefined ? {} : { apiKeySecret: secret }) };
};

export type AddModelChoice = Extract<ModelsOperation, { kind: 'addModel' }>['choice'];

const choiceOf = (connection: Json, model: Json): AddModelChoice => ({ connection: connection as ConnectionDraft, model: model as ModelEntry });

const addOperation = (connection: Json, model: Json): ModelsOperation => ({ kind: 'addModel', choice: choiceOf(connection, model) });

export const entryOf = (id: string, window: number | undefined): Json => ({ id, ...(window === undefined ? {} : { capabilities: { contextWindow: window, maxOutputTokens: maxOutputTokensFor(window) } }) });

const windowOf = (input: FormInput): number | undefined => {
  const text = optionText(input, 'window');
  return text === undefined ? undefined : wholeNumber(text, 1);
};

export const addProposalOf = (edit: ModelsEdit, connection: Json, model: Json, confirm?: string): ModelsProposal => ({
  operations: [addOperation(connection, model)],
  confirm: (plan) => confirm ?? `Add ${addedDisplayOf(edit, plan)} to your settings?`,
});

export const foundRowOf = (server: DetectedLocalServer): string => `${server.provider}${SEPARATOR}${server.address}${SEPARATOR}${server.models.length} ${server.models.length === 1 ? 'model' : 'models'}`;

export const kindOf = (server: DetectedLocalServer): ServerKind => {
  const kind = SERVER_KINDS.find((candidate) => candidate.kind === server.kind);
  if (kind === undefined) throw new ShellRefusal(`The server at ${server.address} is of the kind "${server.kind}", which this version does not know.`);
  return kind;
};

const detectedConnectionOf = (server: DetectedLocalServer, kind: ServerKind): Json => ({ adapter: kind.adapter, baseUrl: server.address, provider: server.provider, ...kind.settings });

export const detectedChoiceOf = (server: DetectedLocalServer, model: DetectedModel, window: number | undefined): AddModelChoice =>
  choiceOf(detectedConnectionOf(server, kindOf(server)), entryOf(model.id, window));

export const foundProposalOf = (edit: ModelsEdit, input: FormInput, server: DetectedLocalServer, model: DetectedModel): ModelsProposal => {
  const kind = kindOf(server);
  const api = optionText(input, 'api');
  const service = optionText(input, 'service');
  const connection = {
    ...detectedConnectionOf(server, kind),
    ...(kind.kind === GENERIC_SERVER_KIND && api !== undefined ? { adapter: adapterOfApi(api) } : {}),
    ...(service === undefined ? {} : { provider: service }),
    ...keyReferenceOf(input),
  };
  return addProposalOf(edit, connection, entryOf(model.id, windowOf(input) ?? model.contextWindow));
};

const proposeSearchedAdd = async (shell: ModelsHost, edit: ModelsEdit, input: FormInput, print: Print): Promise<ModelsProposal> => {
  const servers = offeredServers(await shell.detect({ candidates: LOCAL_SERVER_CANDIDATES, typed: [], signal: shell.interrupt }));
  if (servers.length === 0) throw new ShellRefusal(NO_SERVER_ANSWERED_TEXT);
  const id = optionText(input, 'model');
  if (id === undefined) {
    print(servers.map(foundRowOf));
    throw new UsageError();
  }
  const holders = servers.flatMap((server) => server.models.filter((model) => model.id === id).map((model) => ({ server, model })));
  const [only, ...others] = holders;
  if (only === undefined) throw new ShellRefusal(`No model server on this computer lists "${id}".`);
  if (others.length > 0) throw new ShellRefusal(`"${id}" is listed by ${serverCountText(holders.length)} servers: ${holders.map((holder) => holder.server.provider).join(', ')}. Run again with --address.`);
  return foundProposalOf(edit, input, only.server, only.model);
};

const proposeAddressedAdd = async (shell: ModelsHost, edit: ModelsEdit, input: FormInput, address: string, print: Print): Promise<ModelsProposal> => {
  const [server] = (await shell.detect({ candidates: [], typed: [address], signal: shell.interrupt })).filter(isLocalServer);
  const id = optionText(input, 'model');
  if (server === undefined) {
    const api = optionText(input, 'api');
    if (api === undefined || id === undefined) throw new ShellRefusal(noServerAnsweredAtText(address));
    const service = optionText(input, 'service');
    const connection = { adapter: adapterOfApi(api), baseUrl: address, ...(service === undefined ? {} : { provider: service }), ...keyReferenceOf(input) };
    return addProposalOf(edit, connection, entryOf(id, windowOf(input)), noServerAnsweredAtText(address));
  }
  if (id === undefined) {
    print([foundRowOf(server)]);
    throw new UsageError();
  }
  const model = server.models.find((candidate) => candidate.id === id);
  if (model === undefined) throw new ShellRefusal(`The server at ${address} does not list "${id}".`);
  return foundProposalOf(edit, input, server, model);
};

const proposeAdd = async (shell: ModelsHost, edit: ModelsEdit, input: FormInput, print: Print): Promise<ModelsProposal> => {
  const profile = optionText(input, 'plan');
  if (profile !== undefined) {
    const account = optionText(input, 'account');
    return addProposalOf(edit, { adapter: 'open-responses', plan: { profile, ...(account === undefined ? {} : { account }) } }, entryOf(requiredOption(input, 'model'), windowOf(input)));
  }
  const address = optionText(input, 'address');
  return address === undefined ? proposeSearchedAdd(shell, edit, input, print) : proposeAddressedAdd(shell, edit, input, address, print);
};

const proposeRemove = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const model = canonOfTyped(edit, argument(input, 0));
  return {
    operations: [{ kind: 'removeModel', model }],
    confirm: (plan) => `Remove ${displayIn(edit, model)}?${alsoModelFor(plan.references)} Sessions that used it keep their history.`,
  };
};

const proposeRemoveServer = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const provider = argument(input, 0);
  const count = edit.resolved.views.filter((view) => view.provider === provider).length;
  return {
    operations: [{ kind: 'removeConnection', provider, ...(input.options['forgetProgram'] === true ? { forgetServer: true } : {}) }],
    confirm: (plan) =>
      count === 1
        ? `Remove ${provider} and its model?${alsoModelFor(plan.references)} Sessions that used it keep their history.`
        : `Remove ${provider} and its ${count} models?${alsoModelFor(plan.references)} Sessions that used them keep their history.`,
  };
};

const proposeStart = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  if (input.options['clear'] === true) return { operations: [{ kind: 'setStart', model: null }], confirm: () => 'Start new sessions with the first model in your settings?' };
  const model = canonOfTyped(edit, argument(input, 0));
  return { operations: [{ kind: 'setStart', model }], confirm: () => `Start new sessions with ${displayIn(edit, model)}?` };
};

const placedAt = (order: readonly string[], model: string, position: number): string[] => {
  const others = order.filter((entry) => entry !== model);
  return [...others.slice(0, position - 1), model, ...others.slice(position - 1)];
};

const positionOf = (text: string, last: number): number => {
  const position = wholeNumber(text, 1);
  if (position > last) throw new UsageError();
  return position;
};

const proposeFallbackAdd = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const model = canonOfTyped(edit, argument(input, 0));
  const last = edit.resolved.fallback.filter((entry) => entry !== model).length + 1;
  const given = optionText(input, 'position');
  const position = given === undefined ? last : positionOf(given, last);
  return { operations: [{ kind: 'setFallback', models: placedAt(edit.resolved.fallback, model, position) }], confirm: () => `Add ${displayIn(edit, model)} as fallback ${position}?` };
};

const fallbackMemberOf = (edit: ModelsEdit, input: FormInput): string => {
  const model = canonOfTyped(edit, argument(input, 0));
  if (!edit.resolved.fallback.includes(model)) throw new ShellRefusal(`${displayIn(edit, model)} is not one of the fallback models.`);
  return model;
};

const proposeFallbackRemove = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const model = fallbackMemberOf(edit, input);
  return { operations: [{ kind: 'setFallback', models: edit.resolved.fallback.filter((entry) => entry !== model) }], confirm: () => `Remove ${displayIn(edit, model)} from the fallback models?` };
};

const proposeFallbackMove = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const text = argument(input, 0);
  const to = requiredOption(input, 'to');
  const model = fallbackMemberOf(edit, { ...input, args: [text] });
  const position = positionOf(to, edit.resolved.fallback.length);
  return { operations: [{ kind: 'setFallback', models: placedAt(edit.resolved.fallback, model, position) }], confirm: () => `Move ${displayIn(edit, model)} to position ${position}?` };
};

const billingOf = (text: string): TargetBilling => {
  const billing = TARGET_BILLINGS.find((candidate) => candidate === text);
  if (billing === undefined) throw new UsageError();
  return billing;
};

const billingChangeOf = (edit: ModelsEdit, input: FormInput): { from: TargetBilling; to: TargetBilling; model?: string } => {
  const from = billingOf(argument(input, 0));
  const to = billingOf(argument(input, 1));
  const scope = optionText(input, 'model');
  return { from, to, ...(scope === undefined ? {} : { model: canonOfTyped(edit, scope) }) };
};

const scopeText = (edit: ModelsEdit, model: string | undefined): string => (model === undefined ? '' : ` for ${displayIn(edit, model)}`);

const proposeBillingAllow = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const change = billingChangeOf(edit, input);
  return { operations: [{ kind: 'allowBillingChange', ...change }], confirm: () => `Allow requests to fall from ${change.from} to ${change.to}${scopeText(edit, change.model)}?` };
};

const proposeBillingForbid = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const change = billingChangeOf(edit, input);
  return { operations: [{ kind: 'forbidBillingChange', ...change }], confirm: () => `Forbid requests to fall from ${change.from} to ${change.to}${scopeText(edit, change.model)}?` };
};

const CLASSIFIER_JOB = 'classifier';

const roleOperationOf = (job: string, model: string | null): ModelsOperation => {
  if (job === CLASSIFIER_JOB) return { kind: 'setClassifier', model };
  if (job === 'compaction' || job === 'reflection' || job === 'analysis') return { kind: 'setRole', job, model };
  throw new UsageError();
};

const proposeRoleSet = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const job = argument(input, 0);
  const text = argument(input, 1);
  roleOperationOf(job, null);
  const model = canonOfTyped(edit, text);
  return { operations: [roleOperationOf(job, model)], confirm: () => `Use ${displayIn(edit, model)} for ${JOB_WORDS[job]}?` };
};

const proposeRoleClear = async (_shell: ModelsHost, _edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const job = argument(input, 0);
  return { operations: [roleOperationOf(job, null)], confirm: () => `Use ${SESSION_MODEL_TEXT} for ${JOB_WORDS[job]}?` };
};

const typedValueOf = (text: string): unknown => {
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError) return text;
    throw error;
  }
  return typeof parsed === 'number' || typeof parsed === 'boolean' ? parsed : text;
};

const ENTRY_FIELD_PREFIX = 'models[].';

const RENAMED_FIELD = 'id';

const proposeModelField = (set: boolean) => async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const text = argument(input, 0);
  const field = argument(input, 1);
  const written = set ? argument(input, 2) : undefined;
  const value = written === undefined || field === RENAMED_FIELD ? written : typedValueOf(written);
  const model = canonOfTyped(edit, text);
  const keyPath = settableFieldPath('model', field);
  const label = fieldLabel(`${ENTRY_FIELD_PREFIX}${field}`);
  const operations: ModelsOperations = [{ kind: 'setModelField', model, path: keyPath, value }];
  if (set && field === RENAMED_FIELD) return { operations, confirm: () => `Rename ${displayIn(edit, model)} to ${String(value)}?` };
  return {
    operations,
    confirm: () => (set ? `Set ${label} of ${displayIn(edit, model)} to ${fieldValueText(`${ENTRY_FIELD_PREFIX}${field}`, value)}?` : `Clear ${label} of ${displayIn(edit, model)}?`),
  };
};

const proposeServerField = (set: boolean) => async (_shell: ModelsHost, _edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const provider = argument(input, 0);
  const field = argument(input, 1);
  const value = set ? typedValueOf(argument(input, 2)) : undefined;
  return {
    operations: [{ kind: 'setConnectionField', provider, path: settableFieldPath('server', field), value }],
    confirm: () => (set ? `Set ${fieldLabel(field)} of ${provider} to ${fieldValueText(field, value)}?` : `Clear ${fieldLabel(field)} of ${provider}?`),
  };
};

export const derivedNameOf = (edit: ModelsEdit, provider: string): string => {
  const index = edit.resolved.connections.findIndex((connection) => connection.provider === provider);
  const written = connectionsOf(edit.document)[index];
  if (written === undefined) throw new TypeError(`the server ${provider} passed the plan but is not in the settings`);
  return providerNameOf({ ...nameInputOf(written), provider: undefined }, edit.ports.kinds);
};

const proposeName = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const provider = argument(input, 0);
  const clear = input.options['clear'] === true;
  const name = clear ? null : argument(input, 1);
  return {
    operations: [{ kind: 'setProvider', provider, name }],
    confirm: (plan) =>
      `Rename server ${provider} to ${name ?? derivedNameOf(edit, provider)}?${plan.references.length === 0 ? '' : ` This changes: ${referenceList(plan.references)}.`} Conversations that used a model of this server will ask you to choose a model again.`,
  };
};

const refusedMessageOf = (plan: ModelsEditPlan): string | undefined => ('refused' in plan ? plan.refused.message : undefined);

const proposeAddProgram = async (shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const command = requiredOption(input, 'command');
  const readyPath = requiredOption(input, 'readyPath');
  const taken = new Set([...edit.resolved.connections.map((connection) => connection.provider), ...Object.keys(edit.resolved.servers)]);
  const id = optionText(input, 'name') ?? serverNameFromCommand(command, taken, shell.platform);
  if (id === undefined) throw new UsageError();
  const program: DeclaredProgram = { id, command, args: optionList(input, 'arg'), readyPath };
  const declare: ModelsOperation = { kind: 'declareServer', ...program };
  const refused = refusedMessageOf(planModelsEdit(edit.document, [declare], edit.ports));
  if (refused !== undefined) throw new ShellRefusal(refused);
  const model = optionText(input, 'model') ?? (await shell.programModel(program, shell.interrupt));
  return {
    operations: [declare, addOperation({ adapter: 'managed', server: id }, { id: model })],
    confirm: (plan) => `Add ${id} (${command}) as a model server with the model ${addedDisplayOf(edit, plan)}?`,
  };
};

const PROGRAM_FIELDS = ['command', 'args', 'readyPath'] as const;

const programValueOf = (field: (typeof PROGRAM_FIELDS)[number], text: string): unknown => {
  if (field !== 'args') return text;
  const parsed: unknown = parseOutsideJson(text);
  if (!Array.isArray(parsed)) throw new UsageError();
  return parsed;
};

const proposeSetProgram = async (_shell: ModelsHost, _edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const id = argument(input, 0);
  const named = argument(input, 1);
  const text = argument(input, 2);
  const field = PROGRAM_FIELDS.find((candidate) => candidate === named);
  if (field === undefined) throw new UsageError();
  return { operations: [{ kind: 'setServerField', id, field, value: programValueOf(field, text) }], confirm: () => `Set ${field} of ${id}?` };
};

const proposeForgetProgram = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const id = argument(input, 0);
  const users = edit.resolved.connections.filter((connection) => connection.server === id).length;
  return { operations: [{ kind: 'forgetServer', id }], confirm: () => `Forget ${id}? ${users} ${users === 1 ? 'server uses' : 'servers use'} it.` };
};

const MINUTE_MS = 60_000;

const minutesOf = (input: FormInput, name: string): number | undefined => {
  const text = optionText(input, name);
  return text === undefined ? undefined : wholeNumber(text, 0) * MINUTE_MS;
};

const proposeTimeouts = async (_shell: ModelsHost, edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const headersTimeoutMs = minutesOf(input, 'headers');
  const idleTimeoutMs = minutesOf(input, 'idle');
  if (headersTimeoutMs === undefined && idleTimeoutMs === undefined) throw new UsageError();
  return {
    operations: [{ kind: 'setTimeouts', ...(headersTimeoutMs === undefined ? {} : { headersTimeoutMs }), ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }) }],
    confirm: () => `Set the waits to first reply ${durationText(headersTimeoutMs ?? edit.resolved.headersTimeoutMs)}, no data ${durationText(idleTimeoutMs ?? edit.resolved.idleTimeoutMs)}?`,
  };
};

const proposeDialectsSet = async (shell: ModelsHost, _edit: ModelsEdit, input: FormInput): Promise<ModelsProposal> => {
  const file = requiredOption(input, 'file');
  const dialects: unknown = parseOutsideJson(await shell.files.readText(file));
  if (!isRecord(dialects)) throw new ShellRefusal(`${file} does not hold a JSON object.`);
  return { operations: [{ kind: 'setDialects', dialects }], confirm: () => `Save the schema dialects of ${file}?` };
};

export const fallbackRows = (edit: ModelsEdit): string[] =>
  edit.resolved.fallback.length === 0
    ? ['No fallback models. If the model cannot answer, the request fails.']
    : edit.resolved.fallback.map((model, index) => `${index + 1}  ${displayIn(edit, model)}`);

export const billingRows = (edit: ModelsEdit): string[] =>
  edit.resolved.billingChanges.length === 0
    ? ['No billing change is allowed.']
    : edit.resolved.billingChanges.map((change) => `${change.from} → ${change.to}${SEPARATOR}${change.model === undefined ? 'every model' : `only ${displayIn(edit, change.model)}`}`);

export const roleRows = (edit: ModelsEdit): string[] => {
  const { roles, classifier } = edit.resolved;
  const row = (label: string, model: string | undefined): string => `${label}${SEPARATOR}${model === undefined ? SESSION_MODEL_TEXT : displayIn(edit, model)}`;
  return [row('Summaries (compaction)', roles.compaction), row('Reflection', roles.reflection), row('Analysis', roles.analysis), row('Auto-mode classifier', classifier)];
};

const dialectRows = (edit: ModelsEdit): string[] => {
  const models = edit.document['models'];
  const dialects = isRecord(models) && isRecord(models['dialects']) ? models['dialects'] : {};
  return JSON.stringify(dialects, null, 2).split('\n');
};

type Propose = (shell: ModelsHost, edit: ModelsEdit, input: FormInput, print: Print) => Promise<ModelsProposal>;

type FormSpec = { usage: string } & ({ propose: Propose } | { print(edit: ModelsEdit): string[] });

const usage = (form: ModelsForm, rest: string): string => `usage: momonga models ${form}${rest === '' ? '' : ` ${rest}`}`;

const FORM_SPECS: Readonly<Record<ModelsForm, FormSpec>> = {
  add: {
    usage: usage('add', '[--address <url>] --model <own name> [--window <tokens>] [--api ollama|openai|anthropic|responses] [--api-key-env <NAME> | --api-key-secret <name>] [--service <name>] [--plan <profile> [--account <label>]] [--yes]'),
    propose: proposeAdd,
  },
  remove: { usage: usage('remove', '<model> [--yes]'), propose: proposeRemove },
  'remove-server': { usage: usage('remove-server', '<server> [--forget-program] [--yes]'), propose: proposeRemoveServer },
  start: { usage: usage('start', '<model> | --clear [--yes]'), propose: proposeStart },
  'fallback list': { usage: usage('fallback list', ''), print: fallbackRows },
  'fallback add': { usage: usage('fallback add', '<model> [--position <n>] [--yes]'), propose: proposeFallbackAdd },
  'fallback remove': { usage: usage('fallback remove', '<model> [--yes]'), propose: proposeFallbackRemove },
  'fallback move': { usage: usage('fallback move', '<model> --to <n> [--yes]'), propose: proposeFallbackMove },
  'billing list': { usage: usage('billing list', ''), print: billingRows },
  'billing allow': { usage: usage('billing allow', '<from> <to> [--model <model>] [--yes]'), propose: proposeBillingAllow },
  'billing forbid': { usage: usage('billing forbid', '<from> <to> [--model <model>] [--yes]'), propose: proposeBillingForbid },
  'role list': { usage: usage('role list', ''), print: roleRows },
  'role set': { usage: usage('role set', '<compaction|reflection|analysis|classifier> <model> [--yes]'), propose: proposeRoleSet },
  'role clear': { usage: usage('role clear', '<compaction|reflection|analysis|classifier> [--yes]'), propose: proposeRoleClear },
  set: { usage: usage('set', '<model> <field> <value> [--yes]'), propose: proposeModelField(true) },
  unset: { usage: usage('unset', '<model> <field> [--yes]'), propose: proposeModelField(false) },
  'set-server': { usage: usage('set-server', '<server> <field> <value> [--yes]'), propose: proposeServerField(true) },
  'unset-server': { usage: usage('unset-server', '<server> <field> [--yes]'), propose: proposeServerField(false) },
  name: { usage: usage('name', '<server> <name> | <server> --clear [--yes]'), propose: proposeName },
  'add-program': { usage: usage('add-program', '--command <path> [--arg <text>]... --ready-path <path> [--name <name>] [--model <own name>] [--yes]'), propose: proposeAddProgram },
  'set-program': { usage: usage('set-program', '<id> <command|args|readyPath> <value> [--yes]'), propose: proposeSetProgram },
  'forget-program': { usage: usage('forget-program', '<id> [--yes]'), propose: proposeForgetProgram },
  timeouts: { usage: usage('timeouts', '[--headers <minutes>] [--idle <minutes>] [--yes]'), propose: proposeTimeouts },
  'dialects show': { usage: usage('dialects show', ''), print: dialectRows },
  'dialects set': { usage: usage('dialects set', '--file <path> [--yes]'), propose: proposeDialectsSet },
};

export const plannedOf = (edit: ModelsEdit, proposal: ModelsProposal): string => {
  const plan = planModelsEdit(edit.document, proposal.operations, edit.ports);
  if ('refused' in plan) throw new ShellRefusal(plan.refused.message);
  return proposal.confirm(plan);
};

const proposeAndWrite = async (shell: ModelsShell, edit: ModelsEdit, proposal: ModelsProposal, yes: boolean): Promise<number> => {
  print(shell.stdout, [plannedOf(edit, proposal)]);
  if (!yes) {
    print(shell.stderr, [RUN_AGAIN_WITH_YES_TEXT]);
    return EXIT_USAGE;
  }
  const result = await editModelsSettings(shell.home, shell.settingsFile, proposal.operations, { signal: shell.interrupt });
  print(shell.stdout, result.summaries);
  return 0;
};

export const isModelsRefusal = (error: unknown): error is Error => error instanceof ShellRefusal || error instanceof ModelRefError || error instanceof ModelsEditRefused;

export const proposeForm = (host: ModelsHost, edit: ModelsEdit, form: ModelsForm, input: FormInput): Promise<ModelsProposal> => {
  const spec = FORM_SPECS[form];
  if (!('propose' in spec)) throw new TypeError(`momonga models ${form} writes nothing`);
  return spec.propose(host, edit, input, () => undefined);
};

export const runModelsForm = async (shell: ModelsShell, form: ModelsForm, input: FormInput): Promise<number> => {
  const spec = FORM_SPECS[form];
  try {
    const edit = await modelsEditOf(shell);
    announcePlainHttp(shell, edit.resolved.plainHttp);
    if ('print' in spec) {
      print(shell.stdout, spec.print(edit));
      return 0;
    }
    return await proposeAndWrite(shell, edit, await spec.propose(shell, edit, input, (lines) => print(shell.stdout, lines)), input.options['yes'] === true);
  } catch (error) {
    if (error instanceof UsageError) {
      print(shell.stderr, [spec.usage]);
      return EXIT_USAGE;
    }
    if (isModelsRefusal(error)) {
      print(shell.stderr, [error.message]);
      return EXIT_FAILURE;
    }
    throw error;
  }
};

export const programModelOf = async (ports: CliPorts, paths: MomongaPaths, program: ServerProgram, signal: AbortSignal, onWarning: (message: string) => void): Promise<string> => {
  const { probeManagedFm, systemProcessFiles } = await import('@momonga/gateway');
  const { settings } = await loadUserSettings({ home: ports.home });
  const declared = 'builtIn' in program ? undefined : { [program.id]: { command: program.command, args: [...program.args], readyPath: program.readyPath } };
  const description = registeredServer(serverRegistryOf(declared, paths.settingsFile), program.id);
  if (description === undefined) throw new TypeError(`the server program ${program.id} is not in the registry of server programs`);
  const { report } = await probeManagedFm({
    paths,
    platform: ports.platform,
    instance: cliProbeInstance(paths, program.id),
    description,
    target: program.id,
    binary: 'builtIn' in program ? description.binary.defaultPath : program.command,
    readyTimeoutMs: description.ready.limitMs,
    env: ports.env,
    userDialects: settings.models.dialects,
    signal,
    hashes: createBinaryHashCache(),
    isUsableBinary: systemProcessFiles.isUsableBinary,
    readStopGraceMs: () => settings.gateway.managedServerStopGraceMs,
    onWarning,
  });
  return report.modelId;
};

export const serversDetector =
  (ports: Pick<CliPorts, 'home' | 'exec' | 'files'>, fetch: OutboundFetch | typeof globalThis.fetch): ModelsShell['detect'] =>
  async (request) => {
    const { detectLocalServers } = await import('@momonga/gateway');
    const { settings } = await loadUserSettings({ home: ports.home });
    return detectLocalServers({ ...request, fetch, ...localManagedPorts(settings.models.servers, ports) });
  };

export const modelsShellOf = (ports: CliPorts, paths: MomongaPaths, interrupt: AbortSignal): ModelsShell => ({
  stdout: ports.stdout,
  stderr: ports.stderr,
  home: ports.home,
  settingsFile: paths.settingsFile,
  platform: ports.platform,
  interrupt,
  files: ports.files,
  listing: async () => {
    await ensureCurrentDaemon(ports, paths);
    const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
    try {
      return await gateway.modelList(interrupt);
    } finally {
      await gateway.close();
    }
  },
  detect: (request) => withIdentityReadFetch(ports, request.signal, (fetch) => serversDetector(ports, fetch)(request)),
  programModel: (program, signal) => programModelOf(ports, paths, program, signal, (message) => ports.stderr.write(`${escapedLines([`momonga: ${message}`])}\n`)),
});
