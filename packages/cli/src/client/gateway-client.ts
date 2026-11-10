import { createUdsClient, isRecord, parseOutsideJson } from '@momonga/foundation';
import type { SocketResolver } from '@momonga/foundation';
import { JSON_MODES, PLAN_ACCOUNT_STATES, PLAN_API_PREFIX, PLAN_REVOCATIONS, PLAN_ROUTES, TARGET_ANSWERS, TARGET_BILLINGS, TARGET_HEALTH_REASONS, displayMapOf, isNotListedCapabilities, isToolCallingState, notListedMessage, planAccountRefOf } from '@momonga/protocol';
import type {
  Capabilities,
  GatewayHealth,
  MomongaModelEntry,
  MomongaModelList,
  ModelViews,
  PlanAccountView,
  PlanAccountsResponse,
  PlanActiveRequest,
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
  UsageReport,
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

const answerBodyOf = (text: string): GatewayAnswerBody | undefined => {
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(text);
  } catch {
    return undefined;
  }
  const error = isRecord(parsed) ? parsed['error'] : undefined;
  return isRecord(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string' ? { code: error['code'], message: error['message'] } : undefined;
};

export type PlanGatewayClient = {
  accounts(): Promise<PlanAccountsResponse>;
  signInBegin(request: PlanSignInBeginRequest): Promise<PlanSignInBeginResponse>;
  signInComplete(request: PlanSignInCompleteRequest): Promise<PlanSignInCompleteResponse>;
  signInCancel(request: PlanSignInCancelRequest): Promise<void>;
  signOut(request: PlanSignOutRequest): Promise<PlanSignOutResponse>;
  setActive(request: PlanActiveRequest): Promise<PlanActiveResponse>;
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
  usageOf(runId: string): Promise<UsageReport>;
  health(): Promise<GatewayHealth>;
  readonly plan: PlanGatewayClient;
  close(): Promise<void>;
};

const OK_STATUS = 200;

const oneOf = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);

const isCapabilities = (value: unknown): value is Capabilities =>
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
  typeof value['schemaDialect'] === 'string' &&
  value['schemaDialect'] !== '' &&
  oneOf(value['tokenCounting'], ['exact', 'calibrated', 'estimated']) &&
  typeof value['usageReported'] === 'boolean' &&
  typeof value['maxConcurrency'] === 'number' &&
  oneOf(value['source'], ['declared', 'probed', 'config', 'unprobed']) &&
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
  isString(value['adapter']) &&
  oneOf(value['answers'], TARGET_ANSWERS) &&
  isString(value['upstream']) &&
  isOptional(value['plan'], isTargetPlan) &&
  isOptional(value['key'], (key) => isRecord(key) && isString(key['group'])) &&
  isListedCapabilities(value['capabilities']);

const isModelEntry = (entry: unknown): boolean =>
  isRecord(entry) &&
  isString(entry['id']) &&
  isString(entry['provider']) &&
  isString(entry['ownName']) &&
  isOptional(entry['defaultTag'], isString) &&
  isBilling(entry['billing']) &&
  isListedCapabilities(entry['capabilities']) &&
  Array.isArray(entry['chain']) &&
  entry['chain'].every(isChainMember);

const isModelList = (value: unknown): value is MomongaModelList =>
  isRecord(value) &&
  Array.isArray(value['data']) &&
  value['data'].every(isModelEntry) &&
  (value['start'] === null || isString(value['start'])) &&
  isRecordOf(value['roles'], isString);

export const listingViewsOf = (entries: readonly MomongaModelEntry[]): ModelViews =>
  entries.map((entry) => ({ canon: entry.id, provider: entry.provider, ownName: entry.ownName, ...(entry.defaultTag === undefined ? {} : { defaultTag: entry.defaultTag }) }));

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
  oneOf(value['state'], ['running', 'draining']);

const isProfileMessages = (value: unknown): boolean =>
  isRecord(value) &&
  ['identityLabel', 'pickerLabel', 'apiKeyLabel', 'inviteTitle', 'description', 'planInUseLabel', 'manageUsageLabel', 'usageLimitMessage', 'signInExpiredMessage', 'signInRequiredMessage', 'planNotEnabledMessage', 'notEligibleMessage'].every((key) => isString(value[key])) &&
  isRecord(value['firstSignIn']) &&
  ['title', 'body', 'action'].every((key) => isRecord(value['firstSignIn']) && isString(value['firstSignIn'][key]));

const isProfileView = (value: unknown): value is PlanProfileView =>
  isRecord(value) && isString(value['id']) && isString(value['usageUrl']) && isString(value['loginLabel']) && isProfileMessages(value['messages']);

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

const isCompleteResponse = (value: unknown): value is PlanSignInCompleteResponse =>
  isRecord(value) &&
  ((value['outcome'] === 'retry' && value['reason'] === 'invalid_grant') ||
    (oneOf(value['outcome'], ['signed_in', 'plan_disabled']) && isAccountView(value['account']) && typeof value['firstSignIn'] === 'boolean'));

const isSignOutResponse = (value: unknown): value is PlanSignOutResponse => isRecord(value) && oneOf(value['revocation'], PLAN_REVOCATIONS) && isString(value['usageUrl']);

const isActiveResponse = (value: unknown): value is PlanActiveResponse => isRecord(value) && planAccountRefOf(value['active']) !== undefined;

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

const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isUsageReport = (value: unknown): value is UsageReport =>
  isRecord(value) &&
  typeof value['run_id'] === 'string' &&
  Array.isArray(value['responses']) &&
  Array.isArray(value['steps']) &&
  isRecord(value['total']) &&
  isCount(value['total']['input_tokens']) &&
  isCount(value['total']['output_tokens']) &&
  isCount(value['total']['total_tokens']);

export const createGatewayClient = (options: { resolveSocket: SocketResolver }): GatewayClient => {
  const http = createUdsClient(options.resolveSocket);

  const getJson = async (path: string, signal?: AbortSignal): Promise<unknown> => {
    const response = await http.request({ method: 'GET', path, ...(signal === undefined ? {} : { signal }) });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}: ${text}`);
    return JSON.parse(text);
  };

  const answer = async (method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> => {
    const response = await http.request({ method, path, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const text = await response.text();
    if (response.status < 200 || response.status > 299) throw new GatewayAnswerError(`${method} ${path} answered ${response.status}: ${text}`, response.status, answerBodyOf(text));
    return text === '' ? undefined : JSON.parse(text);
  };

  const checked = async <T>(method: 'GET' | 'POST', path: string, body: unknown, holds: (value: unknown) => value is T, what: string): Promise<T> => {
    const value = await answer(method, path, body);
    if (!holds(value)) throw new GatewayAnswerError(`${method} ${path} answered a body that is not ${what}: ${JSON.stringify(value)}`, OK_STATUS, undefined);
    return value;
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
    resume: (account, request) => checked('POST', accountRoute(PLAN_ROUTES.accountResume, account), request, isResumeResponse, 'a resume answer'),
    resetHost: () => checked('POST', `${PLAN_API_PREFIX}${PLAN_ROUTES.hostReset}`, {}, isHostResetResponse, 'a host identity'),
    accountModels: (account, request) => checked('GET', `${accountRoute(PLAN_ROUTES.accountModels, account)}?${modelsQuery(request)}`, undefined, isModelsResponse, 'a model catalog'),
    addTarget: (account, request) => checked('POST', accountRoute(PLAN_ROUTES.accountTargets, account), request, isTargetResponse, 'a created target'),
  };

  const health = (): Promise<GatewayHealth> => checked('GET', '/v1/momonga/health', undefined, isGatewayHealth, 'a gateway health report');

  const modelList = async (signal?: AbortSignal): Promise<MomongaModelList> => {
    const body = await getJson('/v1/momonga/models', signal);
    if (!isModelList(body)) throw new Error(`GET /v1/momonga/models answered a body that is not a model list: ${JSON.stringify(body)}`);
    return body;
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

  const usageOf = async (runId: string): Promise<UsageReport> => {
    const path = `/v1/momonga/usage?run_id=${encodeURIComponent(runId)}`;
    const body = await getJson(path);
    if (!isUsageReport(body)) throw new Error(`GET ${path} answered a body that is not a usage report: ${JSON.stringify(body)}`);
    return body;
  };

  return { modelList, models, modelOf, capabilitiesOf, contextWindowOf, usageOf, health, plan, close: () => http.close() };
};
