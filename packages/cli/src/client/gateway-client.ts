import { GENERATION_RETIRED_CODE, HOST_READ_BOUND_MS, JsonDepthError, createUdsClient, isRecord, parseOutsideJson } from '@momonga/foundation';
import type { SocketResolver, UdsClient } from '@momonga/foundation';
import { checkTraceContent } from './contract.ts';
import { MODEL_NAMINGS, MODEL_OUTPUT_KINDS, isReasoningEffort, JSON_MODES, MODEL_ENTRY_STATES, PLAN_ACCOUNT_STATES, PLAN_API_PREFIX, PLAN_REVOCATIONS, PLAN_ROUTES, TARGET_ANSWERS, TARGET_BILLINGS, TARGET_HEALTH_REASONS, displayMapOf, isNotListedCapabilities, isToolCallingState, notListedMessage, planAccountRefOf, INVALID_GRANT_REASON, PLAN_DISABLED_STATE, RETRY_OUTCOME, SIGNED_IN_OUTCOME, IDENTITY_UNCONFIRMED_OUTCOME } from '@momonga/protocol';
import type {
  TraceContentPage,
  Capabilities,
  GatewayHealth,
  MomongaModelEntry,
  MomongaModelList,
  MomongaModelRoles,
  ModelViews,
  PlanAccountView,
  PlanAccountsResponse,
  PlanActiveRequest,
  PlanRenameRequest,
  PlanRenameResponse,
  PlanActiveResponse,
  PlanCatalogEntry,
  PlanHostResetResponse,
  PlanModelsRequest,
  PlanModelsResponse,
  PlanProfileView,
  PlanResumeRequest,
  PlanResumeResponse,
  PlanSignInBeginRequest,
  PlanSignInBeginResponse,
  PlanSignInCancelRequest,
  PlanSignInCompleteRequest,
  PlanSignInCompleteResponse,
  PlanSignOutRequest,
  PlanSignOutResponse,
  PlanTargetRequest,
  PlanTargetResponse,
  TargetHealth,
} from '@momonga/protocol';

export type GatewayAnswerBody = { code: string; message: string };

export class GatewayAnswerError extends Error {
  readonly status: number;
  readonly answer: GatewayAnswerBody | undefined;

  constructor(message: string, status: number, answer: GatewayAnswerBody | undefined) {
    super(message);
    this.name = 'GatewayAnswerError';
    this.status = status;
    this.answer = answer;
  }
}

type HttpMethod = 'GET' | 'POST';

const routeOf = (path: string): string => {
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
};

export const malformedAnswerText = (method: HttpMethod, path: string, what: string): string => `${method} ${routeOf(path)} answered a body that is not ${what}`;

type ParsedBody = { json: true; value: unknown } | { json: false };

const parsedBodyOf = (text: string): ParsedBody => {
  try {
    return { json: true, value: parseOutsideJson(text) };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof JsonDepthError) return { json: false };
    throw error;
  }
};

const answerBodyOf = (text: string): GatewayAnswerBody | undefined => {
  const body = parsedBodyOf(text);
  const error = body.json && isRecord(body.value) ? body.value['error'] : undefined;
  return isRecord(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string' ? { code: error['code'], message: error['message'] } : undefined;
};

export type PlanGatewayClient = {
  accounts(): Promise<PlanAccountsResponse>;
  signInBegin(request: PlanSignInBeginRequest): Promise<PlanSignInBeginResponse>;
  signInComplete(request: PlanSignInCompleteRequest): Promise<PlanSignInCompleteResponse>;
  signInCancel(request: PlanSignInCancelRequest): Promise<void>;
  signOut(request: PlanSignOutRequest): Promise<PlanSignOutResponse>;
  setActive(request: PlanActiveRequest): Promise<PlanActiveResponse>;
  rename(request: PlanRenameRequest): Promise<PlanRenameResponse>;
  resume(account: string, request: PlanResumeRequest): Promise<PlanResumeResponse>;
  resetHost(): Promise<PlanHostResetResponse>;
  accountModels(account: string, request: PlanModelsRequest): Promise<PlanModelsResponse>;
  addTarget(account: string, request: PlanTargetRequest): Promise<PlanTargetResponse>;
};

export type GatewayClient = {
  modelList(signal?: AbortSignal): Promise<MomongaModelList>;
  models(signal?: AbortSignal): Promise<readonly MomongaModelEntry[]>;
  modelOf(model: string): Promise<MomongaModelEntry>;
  capabilitiesOf(model: string): Promise<MomongaModelEntry['capabilities']>;
  contextWindowOf(model: string): Promise<number>;
  contentOf(runId: string, request: { after: number; limit: number }): Promise<TraceContentPage>;
  health(): Promise<GatewayHealth>;
  readonly plan: PlanGatewayClient;
  close(): Promise<void>;
};

const OK_STATUS = 200;

const oneOf = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);

const isCapabilities = (value: unknown): value is Capabilities => isChainCapabilities(value) && typeof value['schemaDialect'] === 'string';

const isChainCapabilities = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  typeof value['contextWindow'] === 'number' &&
  typeof value['maxOutputTokens'] === 'number' &&
  isToolCallingState(value['toolCalling']) &&
  oneOf(value['structuredOutput'], ['json_schema', 'none']) &&
  (value['jsonMode'] === undefined || oneOf(value['jsonMode'], JSON_MODES)) &&
  typeof value['streaming'] === 'boolean' &&
  typeof value['stopSequences'] === 'boolean' &&
  typeof value['imageInput'] === 'boolean' &&
  (value['parallelToolCalls'] === undefined || typeof value['parallelToolCalls'] === 'boolean') &&
  (value['schemaDialect'] === undefined || (typeof value['schemaDialect'] === 'string' && value['schemaDialect'] !== '')) &&
  oneOf(value['tokenCounting'], ['exact', 'calibrated', 'estimated']) &&
  typeof value['usageReported'] === 'boolean' &&
  typeof value['maxConcurrency'] === 'number' &&
  oneOf(value['source'], ['declared', 'reported', 'probed', 'config', 'unprobed']) &&
  (value['tokenErrorRatio'] === undefined || typeof value['tokenErrorRatio'] === 'number') &&
  (value['probedAt'] === undefined || typeof value['probedAt'] === 'string');

const isNotListedListing = (value: unknown): boolean => isRecord(value) && isToolCallingState(value['toolCalling']) && isNotListedCapabilities({ toolCalling: value['toolCalling'] });

const isRecordOf = (value: unknown, holds: (entry: unknown) => boolean): boolean => isRecord(value) && Object.values(value).every(holds);

const isString = (value: unknown): value is string => typeof value === 'string';

const isOptional = (value: unknown, holds: (entry: unknown) => boolean): boolean => value === undefined || holds(value);

const isTargetPlan = (value: unknown): boolean => isRecord(value) && isString(value['profile']) && isOptional(value['account'], isString);

const isListedCapabilities = (value: unknown): boolean => isCapabilities(value) || isNotListedListing(value);

const isBilling = (value: unknown): boolean => oneOf(value, TARGET_BILLINGS);

const isChainMember = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value['model']) &&
  isString(value['counter']) &&
  isBilling(value['billing']) &&
  isOptional(value['provider'], isString) &&
  isString(value['adapter']) &&
  oneOf(value['answers'], TARGET_ANSWERS) &&
  isString(value['upstream']) &&
  isOptional(value['plan'], isTargetPlan) &&
  isOptional(value['key'], (key) => isRecord(key) && isString(key['group'])) &&
  isListedCapabilities(value['capabilities']);

const isEntryCapabilities = (value: unknown): boolean => isChainCapabilities(value) || isNotListedListing(value);

const ENTRY_FIELDS: readonly (readonly [string, (value: unknown) => boolean])[] = [
  ['id', isString],
  ['object', (value) => value === 'model'],
  ['provider', isString],
  ['ownName', isString],
  ['defaultTag', (value) => isOptional(value, isString)],
  ['naming', (value) => oneOf(value, MODEL_NAMINGS)],
  ['outputKind', (value) => isOptional(value, (kind) => oneOf(kind, MODEL_OUTPUT_KINDS))],
  ['billing', isBilling],
  ['capabilities', isEntryCapabilities],
  ['state', (value) => oneOf(value, MODEL_ENTRY_STATES)],
  ['chain', (value) => Array.isArray(value) && value.every(isChainMember)],
  ['effort', (value) => isOptional(value, isReasoningEffort)],
];

const unreadableFieldOf = (entry: Record<string, unknown>): string | undefined => ENTRY_FIELDS.find(([field, holds]) => !holds(entry[field]))?.[0];

export const ENTRY_UNREADABLE_CODE = 'model_entry_unreadable';

const unreadableEntryOf = (entry: Record<string, unknown>, index: number, field: string): MomongaModelEntry => {
  const id = isString(entry['id']) ? entry['id'] : `entry ${index + 1}`;
  const provider = isString(entry['provider']) ? entry['provider'] : id;
  const message = `the model list holds ${id} with a ${field} this version cannot read`;
  return {
    id,
    object: 'model',
    provider,
    ownName: isString(entry['ownName']) ? entry['ownName'] : id,
    naming: oneOf(entry['naming'], MODEL_NAMINGS) ? (entry['naming'] as MomongaModelEntry['naming']) : 'account',
    billing: isBilling(entry['billing']) ? (entry['billing'] as MomongaModelEntry['billing']) : 'local',
    capabilities: { toolCalling: { state: 'unavailable', status: 502, type: 'server_error', code: ENTRY_UNREADABLE_CODE, message }, source: 'unprobed' },
    state: 'degraded',
    chain: [],
  };
};

const entriesOf = (data: readonly unknown[]): MomongaModelEntry[] =>
  data.map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const field = isRecord(entry) ? unreadableFieldOf(record) : 'shape';
    return field === undefined ? (record as MomongaModelEntry) : unreadableEntryOf(record, index, field);
  });

const MODEL_LIST_ROLES: Readonly<Record<keyof MomongaModelRoles, true>> = { compaction: true, reflection: true, analysis: true, subagent: true };

const isModelRoles = (value: unknown): boolean => isRecordOf(value, isString) && isRecord(value) && Object.keys(value).every((role) => Object.hasOwn(MODEL_LIST_ROLES, role));

const isModelListFrame = (value: unknown): value is Omit<MomongaModelList, 'data'> & { data: unknown[] } =>
  isRecord(value) && value['object'] === 'list' && Array.isArray(value['data']) && (value['start'] === null || isString(value['start'])) && isModelRoles(value['roles']);

export const listingViewsOf = (entries: readonly MomongaModelEntry[]): ModelViews =>
  entries.map((entry) => ({
    canon: entry.id,
    provider: entry.provider,
    ownName: entry.ownName,
    ...(entry.defaultTag === undefined ? {} : { defaultTag: entry.defaultTag }),
    naming: entry.naming,
    ...(entry.outputKind === undefined ? {} : { outputKind: entry.outputKind }),
  }));

const isTargetHealth = (value: unknown): value is TargetHealth =>
  isRecord(value) &&
  typeof value['ok'] === 'boolean' &&
  oneOf(value['breaker'], ['closed', 'open', 'half-open']) &&
  isOptional(value['reason'], (reason) => oneOf(reason, TARGET_HEALTH_REASONS)) &&
  isOptional(value['detail'], isString) &&
  isOptional(value['remediation'], isString);

const isGatewayHealth = (value: unknown): value is GatewayHealth =>
  isRecord(value) &&
  typeof value['ok'] === 'boolean' &&
  isRecordOf(value['models'], isTargetHealth) &&
  isString(value['version']) &&
  value['apiVersion'] === 1 &&
  typeof value['pid'] === 'number' &&
  isString(value['startedAt']) &&
  oneOf(value['state'], ['running', 'retiring', 'draining']) &&
  typeof value['activeRequests'] === 'number';

const isProfileMessages = (value: unknown): boolean =>
  isRecord(value) &&
  ['identityLabel', 'pickerLabel', 'apiKeyLabel', 'inviteTitle', 'description', 'planInUseLabel', 'manageUsageLabel', 'usageLimitMessage', 'signInExpiredMessage', 'signInRequiredMessage', 'planNotEnabledMessage', 'notEligibleMessage'].every((key) => isString(value[key])) &&
  isRecord(value['firstSignIn']) &&
  ['title', 'body', 'action'].every((key) => isRecord(value['firstSignIn']) && isString(value['firstSignIn'][key]));

const isExternalCliView = (value: unknown): boolean =>
  isRecord(value) && isString(value['command']) && isString(value['loginCommand']) && isString(value['installHint']);

const isProfileView = (value: unknown): value is PlanProfileView =>
  isRecord(value) &&
  isString(value['id']) &&
  isString(value['usageUrl']) &&
  isString(value['loginLabel']) &&
  isProfileMessages(value['messages']) &&
  (value['usesHostIdentity'] === undefined || typeof value['usesHostIdentity'] === 'boolean') &&
  (value['externalCli'] === undefined || isExternalCliView(value['externalCli']));

const isAccountView = (value: unknown): value is PlanAccountView =>
  isRecord(value) &&
  isString(value['profile']) &&
  isString(value['label']) &&
  isOptional(value['email'], isString) &&
  oneOf(value['state'], PLAN_ACCOUNT_STATES) &&
  typeof value['active'] === 'boolean' &&
  Array.isArray(value['pinnedBy']) &&
  value['pinnedBy'].every(isString) &&
  isOptional(value['paused'], (paused) => isRecord(paused) && isOptional(paused['until'], isString)) &&
  isOptional(value['cause'], isString);

const isListProblem = (value: unknown): boolean => isRecord(value) && isString(value['file']) && isString(value['cause']);

const isAccountsResponse = (value: unknown): value is PlanAccountsResponse =>
  isRecord(value) &&
  Array.isArray(value['profiles']) &&
  value['profiles'].every(isProfileView) &&
  Array.isArray(value['accounts']) &&
  value['accounts'].every(isAccountView) &&
  isOptional(value['listProblems'], (problems) => Array.isArray(problems) && problems.every(isListProblem));

const isBeginResponse = (value: unknown): value is PlanSignInBeginResponse =>
  isRecord(value) && isString(value['attemptId']) && isString(value['authorizationUrl']) && isString(value['state']) && isString(value['expiresAt']);

const isSignInIdentity = (value: unknown): boolean => isRecord(value) && isString(value['subject']) && isOptional(value['email'], isString);

const isCompleteResponse = (value: unknown): value is PlanSignInCompleteResponse =>
  isRecord(value) &&
  ((value['outcome'] === RETRY_OUTCOME && value['reason'] === INVALID_GRANT_REASON) ||
    (value['outcome'] === IDENTITY_UNCONFIRMED_OUTCOME && isString(value['attemptId']) && isSignInIdentity(value['identity']) && isString(value['expiresAt'])) ||
    (oneOf(value['outcome'], [SIGNED_IN_OUTCOME, PLAN_DISABLED_STATE]) && isAccountView(value['account']) && typeof value['firstSignIn'] === 'boolean'));

const isSignOutResponse = (value: unknown): value is PlanSignOutResponse => isRecord(value) && oneOf(value['revocation'], PLAN_REVOCATIONS) && isString(value['usageUrl']);

const isRenameResponse = (value: unknown): value is PlanRenameResponse => isRecord(value) && planAccountRefOf(value['renamed'])?.account !== undefined;

const isActiveResponse = (value: unknown): value is PlanActiveResponse => isRecord(value) && planAccountRefOf(value['active'])?.account !== undefined;

const isCatalogEntry = (value: unknown): value is PlanCatalogEntry =>
  isRecord(value) &&
  isString(value['slug']) &&
  isString(value['displayName']) &&
  ((value['usable'] === true && typeof value['contextWindow'] === 'number' && typeof value['maxOutputTokens'] === 'number') || (value['usable'] === false && isString(value['reason'])));

const isModelsResponse = (value: unknown): value is PlanModelsResponse => isRecord(value) && isString(value['readAt']) && Array.isArray(value['models']) && value['models'].every(isCatalogEntry);

const isTargetResponse = (value: unknown): value is PlanTargetResponse => isRecord(value) && isString(value['model']);

const isResumeResponse = (value: unknown): value is PlanResumeResponse => isRecord(value) && typeof value['resumed'] === 'boolean';

const isHostResetResponse = (value: unknown): value is PlanHostResetResponse => isRecord(value) && isString(value['hostId']);

const modelsQuery = (request: PlanModelsRequest): string => new URLSearchParams({ profile: request.profile, ...(request.refresh === true ? { refresh: '1' } : {}) }).toString();

const accountRoute = (route: string, account: string): string => `${PLAN_API_PREFIX}${route.replace(':account', encodeURIComponent(account))}`;

const retiredRefusalOf = (text: string): string | undefined => {
  const body = parsedBodyOf(text);
  const error = body.json && isRecord(body.value) ? body.value['error'] : undefined;
  return isRecord(error) && error['code'] === GENERATION_RETIRED_CODE && typeof error['message'] === 'string' ? error['message'] : undefined;
};

const MODELS_PATH = '/v1/momonga/models';

const MODEL_LIST_KIND = 'a model list';

export const createGatewayClient = (options: { resolveSocket: SocketResolver }): GatewayClient => {
  const dial = (): UdsClient => createUdsClient(options.resolveSocket, { connectTimeoutMs: HOST_READ_BOUND_MS });

  let http = dial();

  const leaveRetiredGeneration = async (): Promise<void> => {
    const retired = http;
    http = dial();
    await retired.close();
  };

  type Sent = { status: number; text: string };

  const sendOnce = async (method: HttpMethod, path: string, body: unknown, signal: AbortSignal | undefined): Promise<Sent> => {
    const response = await http.request({ method, path, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ...(signal === undefined ? {} : { signal }) });
    return { status: response.status, text: await response.text() };
  };

  const send = async (method: HttpMethod, path: string, body: unknown, signal: AbortSignal | undefined): Promise<Sent> => {
    const first = await sendOnce(method, path, body, signal);
    if (retiredRefusalOf(first.text) === undefined) return first;
    await leaveRetiredGeneration();
    return sendOnce(method, path, body, signal);
  };

  const getJson = async (path: string, what: string, signal?: AbortSignal): Promise<unknown> => {
    const settled = await send('GET', path, undefined, signal);
    const refusal = retiredRefusalOf(settled.text);
    if (refusal !== undefined) throw new Error(refusal);
    if (settled.status !== 200) throw new Error(`GET ${path} answered ${settled.status}: ${settled.text}`);
    const body = parsedBodyOf(settled.text);
    if (!body.json) throw new Error(malformedAnswerText('GET', path, what));
    return body.value;
  };

  const answer = async (method: HttpMethod, path: string, body: unknown): Promise<string> => {
    const { status, text } = await send(method, path, body, undefined);
    if (status < 200 || status > 299) {
      const refusal = answerBodyOf(text);
      throw new GatewayAnswerError(refusal === undefined ? `${method} ${path} answered ${status}: ${text}` : refusal.message, status, refusal);
    }
    return text;
  };

  const checked = async <T>(method: HttpMethod, path: string, body: unknown, holds: (value: unknown) => value is T, what: string): Promise<T> => {
    const answered = parsedBodyOf(await answer(method, path, body));
    if (!answered.json || !holds(answered.value)) throw new GatewayAnswerError(malformedAnswerText(method, path, what), OK_STATUS, undefined);
    return answered.value;
  };

  const plan: PlanGatewayClient = {
    accounts: () => checked('GET', `${PLAN_API_PREFIX}${PLAN_ROUTES.accounts}`, undefined, isAccountsResponse, 'an account list'),
    signInBegin: (request) => checked('POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.signInBegin}`, request, isBeginResponse, 'a sign-in attempt'),
    signInComplete: (request) => checked('POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.signInComplete}`, request, isCompleteResponse, 'a sign-in outcome'),
    signInCancel: async (request) => {
      await answer('POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.signInCancel}`, request);
    },
    signOut: (request) => checked('POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.signOut}`, request, isSignOutResponse, 'a sign-out report'),
    setActive: (request) => checked('POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.accountsActive}`, request, isActiveResponse, 'an active account'),
    rename: (request) => checked('POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.accountRename}`, request, isRenameResponse, 'a renamed account'),
    resume: (account, request) => checked('POST', accountRoute(PLAN_ROUTES.accountResume, account), request, isResumeResponse, 'a resume answer'),
    resetHost: () => checked('POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.hostReset}`, {}, isHostResetResponse, 'a host identity'),
    accountModels: (account, request) => checked('GET', `${accountRoute(PLAN_ROUTES.accountModels, account)}?${modelsQuery(request)}`, undefined, isModelsResponse, 'a model catalog'),
    addTarget: (account, request) => checked('POST', accountRoute(PLAN_ROUTES.accountTargets, account), request, isTargetResponse, 'a created target'),
  };

  const health = (): Promise<GatewayHealth> => checked('GET', '/v1/momonga/health', undefined, isGatewayHealth, 'a gateway health report');

  const modelList = async (signal?: AbortSignal): Promise<MomongaModelList> => {
    const body = await getJson(MODELS_PATH, MODEL_LIST_KIND, signal);
    if (!isModelListFrame(body)) throw new Error(malformedAnswerText('GET', MODELS_PATH, MODEL_LIST_KIND));
    return { ...body, data: entriesOf(body.data) };
  };

  const models = async (signal?: AbortSignal): Promise<readonly MomongaModelEntry[]> => (await modelList(signal)).data;

  const modelOf = async (model: string): Promise<MomongaModelEntry> => {
    const entries = await models();
    const entry = entries.find((candidate) => candidate.id === model);
    if (entry === undefined) throw new Error(`the gateway does not list the model ${displayMapOf(listingViewsOf(entries)).get(model) ?? model}`);
    return entry;
  };

  const capabilitiesOf = async (model: string): Promise<MomongaModelEntry['capabilities']> => (await modelOf(model)).capabilities;

  const contextWindowOf = async (model: string): Promise<number> => {
    const capabilities = await capabilitiesOf(model);
    if (isNotListedCapabilities(capabilities)) throw new Error(notListedMessage(capabilities));
    return capabilities.contextWindow;
  };

  const contentOf = async (runId: string, request: { after: number; limit: number }): Promise<TraceContentPage> => {
    const path = `/v1/momonga/content?${new URLSearchParams({ run_id: runId, after: String(request.after), limit: String(request.limit) }).toString()}`;
    return checkTraceContent(await getJson(path, 'a trace content page'), `GET ${path}`);
  };

  return { modelList, models, modelOf, capabilitiesOf, contextWindowOf, contentOf, health, plan, close: () => http.close() };
};
