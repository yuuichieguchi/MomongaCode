import { declaredCommandProblem, plainHttpWarningText } from '@momonga/config';
import { PROVIDER_NAME_PATTERN, SIGN_IN_REQUIRED_CODE, messageOf } from '@momonga/protocol';
import type { GatewayHealth, PlanAccountView, TargetHealth } from '@momonga/protocol';
import { planServesAccount } from './plan-account.ts';
import { SEPARATOR, addressesOf, configuredWindowsOf, isLocalServer, modelRowText, modelsDocumentOf, notListedOf } from '../../commands/models.ts';
import type { ListedModel, ModelsDocument, ModelsEdit } from '../../commands/models.ts';
import { runAddFlow } from './add.ts';
import { cancellable, chosenThen, hostOf, openEdit, proposeAndWrite, proposeWrite, writeConfirmed } from './context.ts';
import type { ModelsFlowContext, Opened } from './context.ts';
import { untilAborted } from '../flow-step.ts';
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
  MODEL_FILE_PROMPT,
  NOT_SET,
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

export type HubFacts = { document: ModelsDocument; plainHttp: readonly string[]; signInRequired: ReadonlySet<string>; keyedElsewhere: ReadonlySet<string>; serverStates: ReadonlyMap<string, string> };

const modelLabel = (model: ListedModel, facts: HubFacts): string => `${modelRowText(model, facts.document.start)}${facts.signInRequired.has(model.model) ? `${SEPARATOR}${SIGN_IN_REQUIRED_WORD}` : ''}`;

const SERVERS_HEADING = 'Servers';
const MODELS_HEADING = 'Models';
const ACTIONS_HEADING = 'Change';

const stateSuffixOf = (state: string | undefined): string => (state === undefined ? '' : `${SEPARATOR}${state}`);

const grouped = (heading: string, rows: readonly HubRow[]): HubRow[] => (rows.length === 0 ? [] : [{ kind: 'heading', label: heading }, ...rows]);

export const hubRows = (facts: HubFacts): HubRow[] => {
  const { models } = facts.document;
  const providers = [...new Set(models.map((model) => model.provider))].filter((provider) => !facts.keyedElsewhere.has(provider));
  const servers = providers.flatMap((provider): HubRow[] => {
    const address = models.find((model) => model.provider === provider)?.address ?? null;
    return [
      { kind: 'server', provider, label: `${address === null ? provider : `${provider}${SEPARATOR}${address}`}${stateSuffixOf(facts.serverStates.get(provider))}` },
      ...(facts.plainHttp.includes(provider) ? [{ kind: 'warning' as const, label: plainHttpWarningText(provider) }] : []),
    ];
  });
  return [
    ...grouped(SERVERS_HEADING, servers),
    ...grouped(MODELS_HEADING, models.map((model): HubRow => ({ kind: 'model', model: model.model, label: modelLabel(model, facts) }))),
    { kind: 'heading', label: ACTIONS_HEADING },
    ...HUB_ACTIONS.map((action): HubRow => ({ kind: 'action', action, label: action })),
  ];
};

const keyOfRow = (row: HubRow): string | undefined => {
  switch (row.kind) {
    case 'action': return `action:${row.action}`;
    case 'model': return `model:${row.model}`;
    case 'server': return `server:${row.provider}`;
    default: return undefined;
  }
};

const firstChoosableFrom = (rows: readonly HubRow[], from: number): number => {
  const found = rows.findIndex((row, index) => index >= from && row.kind !== 'heading' && row.kind !== 'warning');
  return found < 0 ? from : found;
};

const keyedElsewhereOf = (edit: ModelsEdit, accounts: readonly PlanAccountView[]): ReadonlySet<string> => {
  const local = new Set(edit.resolved.views.filter((view) => view.naming === 'server').map((view) => view.provider));
  return new Set(
    edit.resolved.connections
      .filter(({ plan, provider, apiKeyEnv, apiKeySecret }) => (plan !== undefined && accounts.some((account) => planServesAccount(plan, account))) || (!local.has(provider) && (apiKeyEnv !== undefined || apiKeySecret !== undefined)))
      .map((connection) => connection.provider),
  );
};

const READY_STATE = 'ready';
const NOT_RUNNING_STATE = 'not_running';
const NOT_READY_STATE = 'not ready';

const healthStateOf = (health: TargetHealth): string => (health.ok ? READY_STATE : health.reason ?? NOT_READY_STATE);

const serverStateOf = async (
  context: ModelsFlowContext,
  signal: AbortSignal,
  provider: string,
  facts: { document: ModelsDocument; health: GatewayHealth; resolved: ModelsEdit['resolved']; declared: Readonly<Record<string, unknown>> },
): Promise<string | undefined> => {
  const connection = facts.resolved.connections.find((candidate) => candidate.provider === provider);
  const managed = connection?.server !== undefined && Object.hasOwn(facts.declared, connection.server);
  if (connection?.plan !== undefined || managed) {
    const model = facts.document.models.find((listed) => listed.provider === provider);
    const answer = model === undefined ? undefined : facts.health.models[model.model];
    return answer === undefined ? undefined : healthStateOf(answer);
  }
  const address = addressesOf(facts.resolved).get(provider);
  if (address === undefined) return undefined;
  const answered = (await hostOf(context, signal).detect({ candidates: [], typed: [address], signal, includeWithoutModels: true })).some(isLocalServer);
  return answered ? READY_STATE : NOT_RUNNING_STATE;
};

const serverStatesOf = async (context: ModelsFlowContext, signal: AbortSignal, opened: Opened, document: ModelsDocument, health: GatewayHealth): Promise<ReadonlyMap<string, string>> => {
  const declared = declaredOf(opened.edit);
  const providers = [...new Set(document.models.map((model) => model.provider))];
  const states = await Promise.all(
    providers.map(async (provider): Promise<[string, string][]> => {
      const state = await serverStateOf(context, signal, provider, { document, health, resolved: opened.edit.resolved, declared });
      return state === undefined ? [] : [[provider, state]];
    }),
  );
  return new Map(states.flat());
};

const signInRequiredOf = (document: ModelsDocument, health: GatewayHealth): ReadonlySet<string> =>
  new Set(document.models.filter((model) => health.models[model.model]?.reason === SIGN_IN_REQUIRED_CODE).map((model) => model.model));

const removeModel = (context: ModelsFlowContext, opened: Opened, model: string) => proposeAndWrite(opened, context, 'remove', { args: [model], options: {} });

const removeServer = async (context: ModelsFlowContext, opened: Opened, provider: string, write: typeof proposeAndWrite = proposeAndWrite): Promise<void> => {
  const connection = opened.edit.resolved.connections.find((candidate) => candidate.provider === provider);
  const declared = connection?.server !== undefined && Object.hasOwn(declaredOf(opened.edit), connection.server);
  if (!declared) {
    await write(opened, context, 'remove-server', { args: [provider], options: {} });
    return;
  }
  await chosenThen(context, { title: provider, rows: [{ label: REMOVE_SERVER_ONLY_ROW }, { label: FORGET_PROGRAM_TOO_ROW }] }, async (way) => {
    await write(opened, context, 'remove-server', { args: [provider], options: way === 1 ? { forgetProgram: true } : {} });
  });
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
  await chosenThen(context, { title: provider, rows: SERVER_ACTIONS.map((label) => ({ label })) }, async (index) => {
    const action = SERVER_ACTIONS[index];
    if (action === 'Edit server') await runServerFields(context, provider);
    if (action === 'Name this server') await nameServer(context, opened, provider);
    if (action === 'Remove server') await removeServer(context, opened, provider);
  });
};

export const runRemoveServingConnection = async (context: ModelsFlowContext, provider: string): Promise<void> => removeServer(context, await openEdit(context), provider, proposeWrite);

export const repointAccountConnections = async (context: ModelsFlowContext, profile: string, from: string, to: string): Promise<boolean> => {
  const opened = await openEdit(context);
  const repoint = (provider: string) => ({ kind: 'setConnectionField' as const, provider, path: ['plan', 'account'], value: to });
  const [first, ...rest] = opened.edit.resolved.connections.filter((connection) => connection.plan?.profile === profile && connection.plan.account === from);
  if (first === undefined) return true;
  const written = await writeConfirmed(opened, context, {
    operations: [repoint(first.provider), ...rest.map((connection) => repoint(connection.provider))],
    confirm: () => '',
  });
  return written !== undefined;
};

export const accountConnectionOf = async (context: ModelsFlowContext, account: PlanAccountView): Promise<string | undefined> =>
  (await openEdit(context)).edit.resolved.connections.find((connection) => connection.plan !== undefined && planServesAccount(connection.plan, account))?.provider;

export const runServerActions = async (context: ModelsFlowContext, provider: string): Promise<void> => serverMenu(context, await openEdit(context), provider);

const modelMenu = async (context: ModelsFlowContext, opened: Opened, model: string, label: string): Promise<void> => {
  await chosenThen(context, { title: label.trim(), rows: MODEL_ACTIONS.map((action) => ({ label: action })) }, async (index) => {
    const action = MODEL_ACTIONS[index];
    if (action === 'Edit') await runModelFields(context, model);
    if (action === 'Remove') await removeModel(context, opened, model);
  });
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

const programShownValue = (value: unknown): string => (value === undefined ? NOT_SET : Array.isArray(value) ? value.join(' ') : String(value));

const programValue = async (context: ModelsFlowContext, field: (typeof PROGRAM_FIELD_ROWS)[number]['field']): Promise<string | undefined> => {
  if (field === 'command') return context.overlays.promptText({ title: PROGRAM_PATH_PROMPT, validate: (text) => programCommandProblem(text.trim()) });
  if (field === 'modelFile') return context.overlays.promptText({ title: MODEL_FILE_PROMPT, validate: () => undefined });
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
    const rows = [...PROGRAM_FIELD_ROWS.map((row) => ({ label: `${row.label}  ${programShownValue(shown[row.field])}` })), { label: FORGET_PROGRAM_ROW }];
    const acted = await chosenThen(context, { title: id, rows }, async (index) => {
      const row = PROGRAM_FIELD_ROWS[index];
      if (row === undefined) {
        await proposeAndWrite(opened, context, 'forget-program', { args: [id], options: {} });
        return;
      }
      const value = await programValue(context, row.field);
      if (value === undefined) return;
      await proposeAndWrite(opened, context, 'set-program', { args: [id, row.field, row.field === 'args' ? value : value.trim()], options: {} });
    });
    if (acted === undefined) return;
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
    const acted = await chosenThen(context, { title: PROGRAMS_TITLE, rows: ids.map((label) => ({ label })) }, async (index) => {
      const id = ids[index];
      if (id !== undefined) await programMenu(context, id);
    });
    if (acted === undefined) return;
  }
};

export const checkServers = async (context: ModelsFlowContext, edit: ModelsEdit): Promise<ReadonlySet<string> | undefined> =>
  (await cancellable(context, CHECKING_PHASE, (signal) => notListedOf(hostOf(context, signal), edit.resolved)))?.value;

export const runModelsHub = async (context: ModelsFlowContext): Promise<void> => {
  await context.refreshConnection?.();
  let notListed: ReadonlySet<string> = new Set();
  let at = 0;
  let highlighted: string | undefined;
  for (;;) {
    const opened = await openEdit(context);
    const read = await cancellable(context, CHECKING_PHASE, (signal) =>
      untilAborted(signal, (async () => {
        const [listing, health, { accounts }] = await Promise.all([context.backend.modelList(), context.backend.health(), context.backend.plan.accounts()]);
        const document = modelsDocumentOf(listing, addressesOf(opened.edit.resolved), notListed, configuredWindowsOf(opened.edit.resolved));
        return { health, accounts, document, serverStates: await serverStatesOf(context, signal, opened, document, health) };
      })()),
    );
    if (read === undefined) return;
    const { health, accounts, document, serverStates } = read.value;
    const rows = hubRows({ document, plainHttp: opened.edit.resolved.plainHttp, signInRequired: signInRequiredOf(document, health), keyedElsewhere: keyedElsewhereOf(opened.edit, accounts), serverStates });
    const kept = highlighted === undefined ? -1 : rows.findIndex((row) => keyOfRow(row) === highlighted);
    const acted = await chosenThen(
      context,
      {
        title: MODELS_TITLE,
        showModelInFooter: true,
        lines: document.models.length === 0 ? [messageOf('noModelConnected', 'tui')] : [],
        rows: rows.map((row) => ({ label: row.label, ...(row.kind === 'warning' ? { disabled: true } : {}), ...(row.kind === 'heading' ? { separator: true } : {}) })),
        initial: kept === -1 ? firstChoosableFrom(rows, Math.min(at, rows.length - 1)) : kept,
      },
      async (index) => {
        at = index;
        const row = rows[index];
        if (row === undefined) return;
        highlighted = keyOfRow(row);
        notListed = (await hubRowAct(context, opened, row)) ?? notListed;
      },
    );
    if (acted === undefined) return;
  }
};

const hubRowAct = async (context: ModelsFlowContext, opened: Opened, row: HubRow): Promise<ReadonlySet<string> | undefined> => {
    if (row.kind === 'server') await serverMenu(context, opened, row.provider);
    if (row.kind === 'model') await modelMenu(context, opened, row.model, row.label);
    if (row.kind !== 'action') return undefined;
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
      case 'Check the servers':
        return checkServers(context, opened.edit);
    }
    return undefined;
};
