import { declaredCommandProblem, plainHttpWarningText } from '@momonga/config';
import { PROVIDER_NAME_PATTERN, SIGN_IN_REQUIRED_CODE, messageOf } from '@momonga/protocol';
import type { GatewayHealth } from '@momonga/protocol';
import { SEPARATOR, addressesOf, configuredWindowsOf, modelRowOf, modelsDocumentOf, notListedOf } from '../../commands/models.ts';
import type { ListedModel, ModelsDocument, ModelsEdit } from '../../commands/models.ts';
import { runAddFlow } from './add.ts';
import { cancellable, chosenOf, hostOf, openEdit, proposeAndWrite } from './context.ts';
import type { ModelsFlowContext, Opened } from './context.ts';
import { runModelFields, runServerFields } from './fields.ts';
import { runBillingFlow, runFallbackFlow, runRoleFlow, runStartFlow, runTimeoutsFlow } from './order.ts';
import {
  CHECKING_PHASE,
  FORGET_PROGRAM_ROW,
  FORGET_PROGRAM_TOO_ROW,
  HUB_ACTIONS,
  MODELS_TITLE,
  MODEL_ACTIONS,
  NAME_PROBLEM,
  NO_PROGRAMS,
  PROGRAMS_TITLE,
  PROGRAM_ARGUMENTS_PROMPT,
  PROGRAM_FIELD_ROWS,
  PROGRAM_PATH_PROMPT,
  READY_PATH_PROBLEM,
  READY_PATH_PROMPT,
  REMOVE_SERVER_ONLY_ROW,
  SERVER_ACTIONS,
  SERVER_NAME_PROMPT,
  SIGN_IN_REQUIRED_WORD,
  nameTakenText,
} from './texts.ts';
import type { HubAction } from './texts.ts';

type HubRow =
  | { readonly kind: 'server'; readonly provider: string; readonly label: string }
  | { readonly kind: 'warning'; readonly label: string }
  | { readonly kind: 'model'; readonly model: string; readonly label: string }
  | { readonly kind: 'heading'; readonly label: string }
  | { readonly kind: 'action'; readonly action: HubAction; readonly label: string };

export type HubFacts = { document: ModelsDocument; plainHttp: readonly string[]; signInRequired: ReadonlySet<string> };

const modelLabel = (model: ListedModel, facts: HubFacts): string => `${modelRowOf(model, facts.document.start)}${facts.signInRequired.has(model.model) ? `${SEPARATOR}${SIGN_IN_REQUIRED_WORD}` : ''}`;

const ACTIONS_HEADING = 'Change';

export const hubRows = (facts: HubFacts): HubRow[] => {
  const { models } = facts.document;
  const providers = [...new Set(models.map((model) => model.provider))];
  const blocks = providers.flatMap((provider): HubRow[] => {
    const served = models.filter((model) => model.provider === provider);
    const address = served[0]?.address ?? null;
    return [
      { kind: 'server', provider, label: address === null ? provider : `${provider}${SEPARATOR}${address}` },
      ...(facts.plainHttp.includes(provider) ? [{ kind: 'warning' as const, label: `  ${plainHttpWarningText(provider)}` }] : []),
      ...served.map((model): HubRow => ({ kind: 'model', model: model.model, label: modelLabel(model, facts) })),
    ];
  });
  return [...blocks, { kind: 'heading', label: ACTIONS_HEADING }, ...HUB_ACTIONS.map((action): HubRow => ({ kind: 'action', action, label: action }))];
};

const signInRequiredOf = (document: ModelsDocument, health: GatewayHealth): ReadonlySet<string> =>
  new Set(document.models.filter((model) => health.models[model.model]?.reason === SIGN_IN_REQUIRED_CODE).map((model) => model.model));

const removeModel = (context: ModelsFlowContext, opened: Opened, model: string) => proposeAndWrite(opened, context, 'remove', { args: [model], options: {} });

const removeServer = async (context: ModelsFlowContext, opened: Opened, provider: string): Promise<void> => {
  const connection = opened.edit.resolved.connections.find((candidate) => candidate.provider === provider);
  const declared = connection?.server !== undefined && Object.hasOwn(declaredOf(opened.edit), connection.server);
  if (!declared) {
    await proposeAndWrite(opened, context, 'remove-server', { args: [provider], options: {} });
    return;
  }
  const way = await chosenOf(context, { title: provider, rows: [{ label: REMOVE_SERVER_ONLY_ROW }, { label: FORGET_PROGRAM_TOO_ROW }] });
  if (way === undefined) return;
  await proposeAndWrite(opened, context, 'remove-server', { args: [provider], options: way === 1 ? { forgetProgram: true } : {} });
};

const nameServer = async (context: ModelsFlowContext, opened: Opened, provider: string): Promise<void> => {
  const taken = new Set(opened.edit.resolved.connections.map((connection) => connection.provider).filter((name) => name !== provider));
  const typed = await context.overlays.promptText({
    title: SERVER_NAME_PROMPT,
    validate: (text) => {
      const name = text.trim();
      if (name === '') return undefined;
      if (!PROVIDER_NAME_PATTERN.test(name)) return NAME_PROBLEM;
      return taken.has(name) ? nameTakenText(name) : undefined;
    },
  });
  if (typed === undefined) return;
  const name = typed.trim();
  await proposeAndWrite(opened, context, 'name', name === '' ? { args: [provider], options: { clear: true } } : { args: [provider, name], options: {} });
};

const serverMenu = async (context: ModelsFlowContext, opened: Opened, provider: string): Promise<void> => {
  const index = await chosenOf(context, { title: provider, rows: SERVER_ACTIONS.map((label) => ({ label })) });
  const action = index === undefined ? undefined : SERVER_ACTIONS[index];
  if (action === 'Edit server') await runServerFields(context, provider);
  if (action === 'Name this server') await nameServer(context, opened, provider);
  if (action === 'Remove server') await removeServer(context, opened, provider);
};

const modelMenu = async (context: ModelsFlowContext, opened: Opened, model: string, label: string): Promise<void> => {
  const index = await chosenOf(context, { title: label.trim(), rows: MODEL_ACTIONS.map((action) => ({ label: action })) });
  const action = index === undefined ? undefined : MODEL_ACTIONS[index];
  if (action === 'Edit') await runModelFields(context, model);
  if (action === 'Remove') await removeModel(context, opened, model);
};

const declaredOf = (edit: ModelsEdit): Readonly<Record<string, unknown>> => {
  const models = edit.document['models'];
  const servers = typeof models === 'object' && models !== null ? (models as Record<string, unknown>)['servers'] : undefined;
  return typeof servers === 'object' && servers !== null ? (servers as Record<string, unknown>) : {};
};

export const programCommandProblem = (command: string): string | undefined => {
  const problem = declaredCommandProblem(command);
  return problem === undefined ? undefined : `The command ${problem}`;
};

const programValue = async (context: ModelsFlowContext, field: (typeof PROGRAM_FIELD_ROWS)[number]['field']): Promise<string | undefined> => {
  if (field === 'command') return context.overlays.promptText({ title: PROGRAM_PATH_PROMPT, validate: (text) => programCommandProblem(text.trim()) });
  if (field === 'args') {
    const text = await context.overlays.promptText({ title: PROGRAM_ARGUMENTS_PROMPT, validate: () => undefined });
    return text === undefined ? undefined : JSON.stringify(text.split(/\s+/).filter((part) => part !== ''));
  }
  return context.overlays.promptText({ title: READY_PATH_PROMPT, validate: (text) => (text.trim().startsWith('/') ? undefined : READY_PATH_PROBLEM) });
};

const programMenu = async (context: ModelsFlowContext, id: string): Promise<void> => {
  for (;;) {
    const opened = await openEdit(context);
    const program = declaredOf(opened.edit)[id];
    if (typeof program !== 'object' || program === null) return;
    const shown = program as Record<string, unknown>;
    const rows = [...PROGRAM_FIELD_ROWS.map((row) => ({ label: `${row.label}  ${Array.isArray(shown[row.field]) ? (shown[row.field] as unknown[]).join(' ') : String(shown[row.field])}` })), { label: FORGET_PROGRAM_ROW }];
    const index = await chosenOf(context, { title: id, rows });
    if (index === undefined) return;
    const row = PROGRAM_FIELD_ROWS[index];
    if (row === undefined) {
      await proposeAndWrite(opened, context, 'forget-program', { args: [id], options: {} });
      continue;
    }
    const value = await programValue(context, row.field);
    if (value === undefined) continue;
    await proposeAndWrite(opened, context, 'set-program', { args: [id, row.field, row.field === 'args' ? value : value.trim()], options: {} });
  }
};

export const runProgramsFlow = async (context: ModelsFlowContext): Promise<void> => {
  for (;;) {
    const { edit } = await openEdit(context);
    const ids = Object.keys(declaredOf(edit)).sort();
    if (ids.length === 0) {
      context.info(NO_PROGRAMS);
      return;
    }
    const index = await chosenOf(context, { title: PROGRAMS_TITLE, rows: ids.map((label) => ({ label })) });
    const id = index === undefined ? undefined : ids[index];
    if (id === undefined) return;
    await programMenu(context, id);
  }
};

export const checkServers = async (context: ModelsFlowContext, edit: ModelsEdit): Promise<ReadonlySet<string> | undefined> =>
  (await cancellable(context, CHECKING_PHASE, (signal) => notListedOf(hostOf(context, signal), edit.resolved)))?.value;

export const runModelsHub = async (context: ModelsFlowContext): Promise<void> => {
  let notListed: ReadonlySet<string> = new Set();
  let at = 0;
  for (;;) {
    const opened = await openEdit(context);
    const [listing, health] = await Promise.all([context.backend.modelList(), context.backend.health()]);
    const document = modelsDocumentOf(listing, addressesOf(opened.edit.resolved), notListed, configuredWindowsOf(opened.edit.resolved));
    const rows = hubRows({ document, plainHttp: opened.edit.resolved.plainHttp, signInRequired: signInRequiredOf(document, health) });
    const index = await chosenOf(context, {
      title: MODELS_TITLE,
      lines: document.models.length === 0 ? [messageOf('noModelConnected', 'tui')] : [],
      rows: rows.map((row) => ({ label: row.label, ...(row.kind === 'warning' ? { disabled: true } : {}), ...(row.kind === 'heading' ? { separator: true } : {}) })),
      initial: Math.min(at, rows.length - 1),
      filter: false,
    });
    const row = index === undefined ? undefined : rows[index];
    if (index === undefined || row === undefined) return;
    at = index;
    if (row.kind === 'server') await serverMenu(context, opened, row.provider);
    if (row.kind === 'model') await modelMenu(context, opened, row.model, row.label);
    if (row.kind !== 'action') continue;
    switch (row.action) {
      case 'Add a model':
        await runAddFlow(context);
        break;
      case 'Model for new sessions':
        await runStartFlow(context);
        break;
      case 'Fallback models':
        await runFallbackFlow(context);
        break;
      case 'Billing changes':
        await runBillingFlow(context);
        break;
      case 'Models for other roles':
        await runRoleFlow(context);
        break;
      case 'Wait limits':
        await runTimeoutsFlow(context);
        break;
      case 'Programs':
        await runProgramsFlow(context);
        break;
      case 'Check the servers': {
        const checked = await checkServers(context, opened.edit);
        if (checked !== undefined) notListed = checked;
        break;
      }
    }
  }
};
