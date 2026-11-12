import { Hono } from 'hono';
import type { Context } from 'hono';
import type { MarkerOwners } from '@momonga/tools';
import { ConfigError, assertSessionMcpServers, autoFitDirectoryOf, serverKeyOfLabel, stripCredentialEnv } from '@momonga/config';
import type { ProjectMandate } from '@momonga/config';
import type { AutoFitKey, CredentialRules, PermissionRule } from '@momonga/config';
import { denyingRuleFor } from '@momonga/policy';
import { shellCommandSubject } from '@momonga/tools';
import { canonicalJson, hostPaths, sha256Hex } from '@momonga/foundation';
import type { Clock, FileSystem, GenerationRole, PathResolver } from '@momonga/foundation';
import { AUTO_MODE_UNAVAILABLE, PROMPT_BODY_MAX_BYTES, PROMPT_IMAGE_MAX_BYTES, base64ByteLength, RUN_STATUSES, messageOf, TARGET_PROBING_MESSAGE, agentReadiness, isTargetProbeFailed, displayMapOf, startModelOf, isTargetProbing, modelRefErrorOf, readinessText, resolveStoredModelRef, resolveTypedModelRef, storedModelRef, typedModelText, INBOX_FULL_CODE, USER_SHELL_RUN_ACTIVE_CODE, inboxFullMessage, outputReserveFor } from '@momonga/protocol';
import { ISSUE_PIN } from './issues.ts';
import type { IssuePort, IssueRead } from './issues.ts';
import type { Mandate, Capabilities, CostBreakdownView, GatewayCostReportView, ModelViews, PermissionMode, RunStatus, RunTraceView, CompactSessionRequest } from '@momonga/protocol';
import { mentionsOf } from '@momonga/context';
import type { AttachedMentions } from '@momonga/context';
import { SkillActivationError, UnknownSkillError } from '@momonga/skills';
import { JournalThreadError, SESSION_PAGE_ROWS, inboxRowView, knownValue, sameRunRequest } from '@momonga/store';
import type { ContextCharge, ListedSession, Run, RuntimeStore, Session } from '@momonga/store';
import { GatewayRequestError, ModelUnlistedError } from '../gateway-client.ts';
import { sessionModelNotConfiguredText } from '../worker/model-texts.ts';
import type { AgentCatalogPort, SkillsPort, UserInputPort } from '../ports.ts';
import { registerUserShellRoutes } from './user-shell-routes.ts';
import type { SandboxKind } from '../process/sandbox-kind.ts';
import {
  ApiError,
  conflict,
  configError,
  contributionUnavailable,
  errorResponse,
  gatewayAnswer,
  imageInputUnsupported,
  idempotencyKeyReused,
  internalErrorResponse,
  invalidRequest,
  methodNotAllowed,
  modeNotAllowed,
  modelNotConfigured,
  moved,
  notFound,
  serviceUnavailable,
  skillUnavailable,
  starting,
  targetNotReady,
  targetProbeFailed,
  imageTooLarge,
  unknownSkill,
} from './errors.ts';
import { STREAM_HEADERS, eventStreamResponse } from './event-stream.ts';
import type { EventSource } from './event-stream.ts';
import type { RunNotifier } from './notifier.ts';
import { JSON_MEDIA_TYPES, PATCH_MEDIA_TYPES, pageLimitOf, parseCursor, parseIdempotencyKey, readJson, validateBody } from './request.ts';
import { compactInputOf, compactPinOf } from '../worker/compact-pin.ts';
import type { AddInboxBody, CreateRunBody, CreateSessionBody, PatchSessionBody, ResolveApprovalBody } from './request.ts';
import { createRecordViews } from '../memory/views.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import type { SkillFileSystem } from '../memory/skill-promotion.ts';
import { contextChargesText, contextChargesView } from './context-charges.ts';
import { registerGuidelineRoutes } from './guidelines.ts';
import { registerMemoryRoutes } from './memories.ts';
import { registerMarkerRoutes } from './markers.ts';
import { registerRuleRoutes } from './rules.ts';
import type { PolicyVerification } from '../process/folder-verification.ts';
import type { GatewayStanding } from '../process/supervised-gateway.ts';
import { registerInputRoutes } from './input-routes.ts';
import type { McpAdminPort } from './input-routes.ts';
import { canonicalProject } from './project-query.ts';
import { registerReportRoutes } from './report-routes.ts';
import type { ReportRouteDeps } from './report-routes.ts';
import { registerTrustRoutes, undecidedFolderNotice } from './trust.ts';
import { requirePersonCapability } from './person-capability.ts';
import type { ServiceTimers } from './timers.ts';
import { answeredByOf } from './answered-by.ts';
import { runTermsOf } from './delegation.ts';
import type { DelegationPort, RunTerms, RunTermsRequest } from './delegation.ts';

const projectMandateOf = async (delegation: DelegationPort | undefined, cwd: string, signal: AbortSignal): Promise<ProjectMandate | undefined> => {
  if (delegation === undefined) return undefined;
  try {
    return await delegation.projectMandate(cwd, signal);
  } catch (error) {
    if (error instanceof ConfigError) throw invalidRequest(error.message, 'mandate');
    throw error;
  }
};
import { readAutoClassifierView } from './auto-classifier-view.ts';
import { isTerminalStatus, toJobView, toAgentView, toRunView, toSessionView, toSkillView } from './views.ts';

export type RunLimitDefaults = { maxSteps: number; maxTotalTokens: number; approvalTtlMs: number; loopThreshold: number };

export type RunServiceDefaults = { runTimeoutMs: number; limits: RunLimitDefaults };

export type ModelListing = { views: ModelViews; start: string | null };

export type SessionCreateSettings = {
  defaultMode?: PermissionMode;
  defaultModeOrigin?: 'user' | 'project' | 'local';
  additionalDirectories: readonly string[];
  credentialEnvNames: readonly string[];
  credentials?: CredentialRules;
  autoModeClassifier?: string;
  autoModeKey?: AutoFitKey;
};

export type RunAppDeps = {
  store: RuntimeStore;
  clock: Clock;
  home: string;
  personCapability: string;
  version: string;
  modelListing: (signal: AbortSignal) => Promise<ModelListing>;
  modelCapabilities: (model: string, signal: AbortSignal) => Promise<Capabilities>;
  sessionCreateSettings: (cwd: string, signal: AbortSignal) => Promise<SessionCreateSettings>;
  sessionReadSettings: (cwd: string, signal: AbortSignal) => Promise<SessionCreateSettings>;
  skills: SkillsPort;
  agents: AgentCatalogPort;
  permissionRules: (session: Session, signal: AbortSignal) => Promise<readonly PermissionRule[]>;
  policyVerification: PolicyVerification;
  gatewayStanding: (signal: AbortSignal) => Promise<GatewayStanding>;
  userInput: UserInputPort;
  evidenceRun: (project: string) => EvidenceRun;
  issues: IssuePort;
  skillFiles: SkillFileSystem;
  platform: NodeJS.Platform;
  isDraining(): boolean;
  beginDraining(): void;
  role(): GenerationRole;
  work: { steps(): number; jobs(): number };
  health: { pid: number; startedAt: string; sandbox: (signal: AbortSignal) => Promise<SandboxKind> };
  protectedRootAreas: readonly string[];
  defaults: RunServiceDefaults;
  notifier: RunNotifier;
  timers: ServiceTimers;
  keepAliveMs: number;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
  retireSignal: AbortSignal;
  retireFrame: () => Uint8Array | undefined;
  runTrace: (runId: string, signal: AbortSignal) => Promise<RunTraceView | undefined>;
  runCost: (runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal, includeRunless: boolean) => Promise<{ report: GatewayCostReportView; text: string }>;
  runCostBreakdown: (runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal, includeRunless: boolean) => Promise<{ breakdown: CostBreakdownView; text: string }>;
  reportCost: ReportRouteDeps['reportCost'];
  runTraceContent: ReportRouteDeps['runTraceContent'];
  recomputeFacts: ReportRouteDeps['recomputeFacts'];
  mcp: McpAdminPort;
  markerOwners: MarkerOwners;
  ignorableMarkerDirectories: (signal: AbortSignal) => Promise<readonly string[]>;
  files: FileSystem;
  onError: (error: unknown) => void;
  delegation?: DelegationPort;
};

export type Handler = (context: Context) => Response | Promise<Response>;

export type RouteAccess = { person: readonly string[] };

export type RouteRegistrar = (routePath: string, handlers: Readonly<Record<string, Handler>>, access?: RouteAccess) => void;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const protectedAreaOf = async (areas: readonly string[], target: string, paths: PathResolver): Promise<string | undefined> => {
  for (const area of areas) {
    if (await paths.comparableContains(area, target)) return area;
  }
  return undefined;
};

const CLIENT_CLOSED_REQUEST_STATUS = 499;

const isAbortOf = (error: unknown, signal: AbortSignal): boolean => signal.aborted && (error === signal.reason || (error instanceof Error && error.cause === signal.reason));

const isMeasuringAnswer = (error: unknown): boolean => error instanceof GatewayRequestError && (isTargetProbing(error) || isTargetProbeFailed(error));

const isGatewayUnavailable = (error: unknown): boolean =>
  error instanceof GatewayRequestError && !isMeasuringAnswer(error) && (error.type === 'transport' || error.status >= 500);

const isClientErrorStatus = (status: number): boolean => status >= 400 && status < 500;

const gatewayGivenUp = (state: string): ApiError =>
  new ApiError({
    status: 503,
    type: 'server_error',
    code: 'gateway_unavailable',
    message: `The model gateway has stopped and the daemon will not start it again (${state}). Run momonga daemon stop; the next momonga command starts the daemon again.`,
  });

const pricesWhileRestarting = (): ApiError =>
  serviceUnavailable('gateway_unavailable', 'The models cannot be reached while the daemon starts them again, and a run with a money budget or a mandate needs their prices. The request was not run; send it again.');

const listingReadFailure = (error: unknown): unknown => {
  if (error instanceof GatewayRequestError && isTargetProbing(error)) return targetNotReady(TARGET_PROBING_MESSAGE);
  if (error instanceof GatewayRequestError && isTargetProbeFailed(error)) return targetProbeFailed(error.message, error.retryAfterMs);
  if (isGatewayUnavailable(error)) return serviceUnavailable('gateway_unavailable', 'the model gateway is unavailable');
  return error;
};

const gatewayReadFailure = (error: unknown): unknown => {
  if (!isMeasuringAnswer(error) && error instanceof ModelUnlistedError) return targetNotReady(readinessText(agentReadiness({ unavailable: error.message })));
  if (isMeasuringAnswer(error) || isGatewayUnavailable(error)) return listingReadFailure(error);
  if (error instanceof GatewayRequestError && isClientErrorStatus(error.status)) {
    return gatewayAnswer({ status: error.status, type: error.type, code: error.code, message: error.message });
  }
  return error;
};

const refuseOversizeImages = (images: readonly { data: string }[] | undefined): void => {
  const oversize = (images ?? []).map((image) => base64ByteLength(image.data)).find((byteLength) => byteLength > PROMPT_IMAGE_MAX_BYTES);
  if (oversize !== undefined) throw imageTooLarge(oversize, PROMPT_IMAGE_MAX_BYTES);
};

const requestedModelOf = (text: string, views: ModelViews): string => {
  const resolution = resolveTypedModelRef(typedModelText(text), views);
  if (resolution.kind === 'found') return resolution.model.canon;
  throw invalidRequest(modelRefErrorOf(text, resolution, views, 'gateway').message, 'model');
};

const displayIn = (views: ModelViews, model: string): string => displayMapOf(views).get(model) ?? model;

const checkModeAllowed = (mode: PermissionMode, bypassAllowed: boolean, autoModeClassifier: string | undefined, views: ModelViews): void => {
  if (mode === 'auto') {
    if (autoModeClassifier === undefined) throw conflict(AUTO_MODE_UNAVAILABLE.code, AUTO_MODE_UNAVAILABLE.message);
    if (resolveStoredModelRef(storedModelRef(autoModeClassifier), views) === undefined) {
      throw conflict(AUTO_MODE_UNAVAILABLE.code, `the auto mode classifier model "${autoModeClassifier}" is not known to the gateway`);
    }
  }
  if (mode === 'bypassPermissions' && !bypassAllowed) {
    throw modeNotAllowed('this session may not use the bypassPermissions mode');
  }
};

const keyedMcpServers = (servers: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> => {
  const keyed = new Map<string, Record<string, unknown>>();
  for (const [label, server] of Object.entries(servers)) {
    const derived = serverKeyOfLabel(label, new Set(keyed.keys()));
    if (derived.kind === 'refused') throw invalidRequest(derived.reason, 'mcpServers');
    keyed.set(derived.key, server);
  }
  return Object.fromEntries(keyed);
};

const checkedMcpServers = (given: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> => {
  const servers = keyedMcpServers(given);
  for (const [name, server] of Object.entries(servers)) {
    try {
      assertSessionMcpServers({ [name]: server });
    } catch (error) {
      if (error instanceof Error) throw invalidRequest(`the MCP server ${JSON.stringify(name)} is refused: ${error.message}`, 'mcpServers');
      throw error;
    }
  }
  return servers;
};

const parseStatusFilter = (raw: string | null): RunStatus[] | undefined => {
  if (raw === null) return undefined;
  const statuses = raw.split(',');
  for (const status of statuses) {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) throw invalidRequest(`unknown run status ${JSON.stringify(status)}`, 'status');
  }
  return statuses as RunStatus[];
};

export const createRunApp = (deps: RunAppDeps): Hono => {
  const { store, notifier } = deps;
  const app = new Hono();

  const requireSession = (id: string) => {
    const session = store.getSession(id);
    if (session === undefined) throw notFound(`session ${id} does not exist`);
    return session;
  };

  const requireRun = (id: string): Run => {
    const run = store.getRun(id);
    if (run === undefined) throw notFound(`run ${id} does not exist`);
    return run;
  };

  const requirePerson = (context: Context): void => requirePersonCapability(context.req.raw, deps.personCapability);

  const route: RouteRegistrar = (routePath, handlers, access) => {
    app.all(routePath, (context) => {
      const method = context.req.method;
      const handler = method === 'HEAD' ? handlers['GET'] : handlers[method];
      if (handler === undefined) throw methodNotAllowed(handlers['GET'] === undefined ? Object.keys(handlers) : [...Object.keys(handlers), 'HEAD']);
      if (access?.person.includes(method) === true) requirePerson(context);
      return handler(context);
    });
  };

  const health: Handler = async (context) =>
  json({
    status: 'ok',
    version: deps.version,
    apiVersion: 1,
    pid: deps.health.pid,
    startedAt: deps.health.startedAt,
    state: deps.isDraining() ? 'draining' : deps.role() === 'retiring' ? 'retiring' : 'running',
    role: deps.role(),
    steps: deps.work.steps(),
    jobs: deps.work.jobs(),
    sandbox: await deps.health.sandbox(context.req.raw.signal),
  });

  const drainingError = () => serviceUnavailable('draining', 'the service is draining and accepts no new work');

  const refusalOfRole: Readonly<Record<GenerationRole, (() => ApiError) | undefined>> = { starting, serving: undefined, retiring: moved };

  const newWorkRefusal = (): ApiError | undefined => (deps.isDraining() ? drainingError() : refusalOfRole[deps.role()]?.());

  const refuseNewWork = (): void => {
    const refusal = newWorkRefusal();
    if (refusal !== undefined) throw refusal;
  };

  const refuseWhileRetiring = (): void => {
    if (deps.isDraining()) throw drainingError();
    if (deps.role() === 'retiring') throw moved();
  };

  const gatewayListing = async (signal: AbortSignal): Promise<ModelListing> => {
    try {
      return await deps.modelListing(signal);
    } catch (error) {
      throw listingReadFailure(error);
    }
  };

  const settingsThrough = async <Loaded>(load: () => Promise<Loaded>): Promise<Loaded> => {
    try {
      return await load();
    } catch (error) {
      if (error instanceof ConfigError) throw configError(error.message);
      throw error;
    }
  };

  const sessionSettingsOf = (cwd: string, signal: AbortSignal): Promise<SessionCreateSettings> => settingsThrough(() => deps.sessionCreateSettings(cwd, signal));

  const sessionReadSettingsOf = (cwd: string, signal: AbortSignal): Promise<SessionCreateSettings> => settingsThrough(() => deps.sessionReadSettings(cwd, signal));

  const listedSessionOf = (id: string): ListedSession => {
    const listed = store.getListedSession(id);
    if (listed === undefined) throw notFound(`session ${id} does not exist`);
    return listed;
  };

  const sessionViewOf = async (session: Session, signal: AbortSignal, loaded?: SessionCreateSettings) => {
    const view = toSessionView(store, listedSessionOf(session.id));
    if (session.permissionMode !== 'auto') return view;
    const settings = loaded ?? (await sessionReadSettingsOf(session.cwd, signal));
    if (settings.autoModeClassifier === undefined || settings.autoModeKey === undefined) return view;
    const autoClassifier = await readAutoClassifierView({ model: settings.autoModeClassifier, key: settings.autoModeKey, directory: autoFitDirectoryOf(deps.home) });
    return { ...view, autoClassifier };
  };

  const createSession: Handler = async (context) => {
    refuseNewWork();
    const body = validateBody<CreateSessionBody>('CreateSessionRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const paths = hostPaths(context.req.raw.signal);
    const resolved = await paths.canonicalDirectory(body.cwd);
    if (!resolved.ok) throw invalidRequest(`cwd ${body.cwd} ${resolved.reason}`, 'cwd');
    const cwd = resolved.path;
    const cwdArea = await protectedAreaOf(deps.protectedRootAreas, cwd, paths);
    if (cwdArea !== undefined) throw invalidRequest(`cwd ${body.cwd} is inside ${cwdArea} and cannot be a session root`, 'cwd');
    const { views, start } = await gatewayListing(context.req.raw.signal);
    const startModel = startModelOf({ count: views.length, start });
    if (startModel === undefined) throw targetNotReady(messageOf('noModelConnected', 'cli'));
    const model = body.model === undefined ? startModel : requestedModelOf(body.model, views);
    const settings = await sessionSettingsOf(cwd, context.req.raw.signal);
    const additionalDirectories: string[] = [];
    const seen = new Set<string>([await paths.comparablePath(cwd)]);
    for (const entry of settings.additionalDirectories) {
      const area = await protectedAreaOf(deps.protectedRootAreas, entry, paths);
      if (area !== undefined) {
        throw configError(`additionalDirectories entry ${entry} is inside ${area} and cannot be a session root`, 'additionalDirectories');
      }
      const key = await paths.comparablePath(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      additionalDirectories.push(entry);
    }
    const permissionMode = body.permissionMode ?? settings.defaultMode ?? 'manual';
    const bypassAllowed =
      body.bypassAllowed === true || (settings.defaultMode === 'bypassPermissions' && settings.defaultModeOrigin === 'user');
    checkModeAllowed(permissionMode, bypassAllowed, settings.autoModeClassifier, views);
    const stripped = stripCredentialEnv(body.env, settings.credentialEnvNames, settings.credentials);
    const mcpServers = checkedMcpServers(body.mcpServers ?? {});
    refuseNewWork();
    const session = store.createSession({ cwd, env: stripped.env, permissionMode, model, bypassAllowed, ...(body.sandboxNetwork === undefined ? {} : { sandboxNetwork: body.sandboxNetwork }), additionalDirectories, mcpServers });
    const notice = body.terminalUi === false ? await undecidedFolderNotice(store.trust, cwd, context.req.raw.signal) : {};
    return json({ session: await sessionViewOf(session, context.req.raw.signal, settings), strippedEnvKeys: stripped.removed, ...notice }, 201, { location: `/v1/sessions/${session.id}` });
  };

  const everySession = (filter: { cwd?: string }): ListedSession[] => {
    const sessions: ListedSession[] = [];
    let cursor: string | null = null;
    do {
      const page = store.listSessions({ ...filter, limit: SESSION_PAGE_ROWS, cursor });
      sessions.push(...page.sessions);
      cursor = page.next;
    } while (cursor !== null);
    return sessions;
  };

  const sessionPageOf = (context: Context, filter: { cwd?: string }): Response => {
    const limit = pageLimitOf(context.req.query('limit'), SESSION_PAGE_ROWS);
    try {
      const page = store.listSessions({ ...filter, limit, cursor: context.req.query('cursor') ?? null });
      return json({ sessions: page.sessions.map((session) => toSessionView(store, session)), next: page.next });
    } catch (error) {
      if (error instanceof RangeError) throw invalidRequest(error.message, 'cursor');
      throw error;
    }
  };

  const listSessions: Handler = async (context) => {
    const requested = context.req.query('cwd');
    if (requested === undefined) return sessionPageOf(context, {});
    return sessionPageOf(context, { cwd: await canonicalProject(requested, 'cwd', context.req.raw.signal) });
  };

  const getSession: Handler = async (context) => json({ session: await sessionViewOf(requireSession(context.req.param('id') ?? ''), context.req.raw.signal) });

  const patchSession: Handler = async (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    requireRootSession(session);
    const body = validateBody<PatchSessionBody>('PatchSessionRequest', await readJson(context.req.raw, PATCH_MEDIA_TYPES, deps.maxBodyBytes));
    if (body.permissionMode !== undefined) {
      const settings = await sessionReadSettingsOf(session.cwd, context.req.raw.signal);
      checkModeAllowed(body.permissionMode, session.bypassAllowed, settings.autoModeClassifier, (await gatewayListing(context.req.raw.signal)).views);
    }
    const model = body.model === undefined ? undefined : requestedModelOf(body.model, (await gatewayListing(context.req.raw.signal)).views);
    const mcpServers = body.mcpServers === undefined ? undefined : checkedMcpServers(body.mcpServers);
    let current = session;
    if (model !== undefined) {
      const switched = store.setModel(session.id, model);
      if (switched.kind === 'not_found') throw notFound(`session ${session.id} does not exist`);
      current = switched.session;
    }
    if (mcpServers !== undefined) {
      const replaced = store.setSessionMcpServers(session.id, mcpServers);
      if (replaced.kind === 'not_found') throw notFound(`session ${session.id} does not exist`);
      current = replaced.session;
    }
    if (body.permissionMode !== undefined) {
      const result = store.setPermissionMode(session.id, body.permissionMode);
      if (result.kind === 'not_found') throw notFound(`session ${session.id} does not exist`);
      current = result.session;
    }
    return json({ session: await sessionViewOf(current, context.req.raw.signal) });
  };

  const listRuns: Handler = (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    const statuses = parseStatusFilter(context.req.query('status') ?? null);
    return json({ runs: store.listRuns(session.id, statuses).map(toRunView) });
  };

  const activationOf = async (session: Session, name: string, signal: AbortSignal) => {
    const skills = await deps.skills.load(session, signal);
    try {
      return await skills.activate(name);
    } catch (error) {
      if (error instanceof UnknownSkillError) throw unknownSkill(error.message);
      if (error instanceof SkillActivationError) throw skillUnavailable(error.message);
      throw error;
    }
  };

  const listSkills: Handler = async (context) => {
    const skills = await deps.skills.load(requireSession(context.req.param('id') ?? ''), context.req.raw.signal);
    return json({ skills: skills.skills.map(toSkillView), warnings: [...skills.warnings] });
  };

  const listAgents: Handler = async (context) => {
    const agents = await deps.agents.load(requireSession(context.req.param('id') ?? ''), context.req.raw.signal);
    return json({ agents: agents.agents.map(toAgentView), warnings: [...agents.warnings] });
  };

  const capabilitiesOf = async (session: Session, signal: AbortSignal): Promise<Capabilities> => {
    try {
      return await deps.modelCapabilities(session.model, signal);
    } catch (error) {
      throw gatewayReadFailure(error);
    }
  };

  const requireImageInput = async (session: Session, images: readonly unknown[] | undefined, signal: AbortSignal): Promise<void> => {
    if (images === undefined || images.length === 0) return;
    if (!(await capabilitiesOf(session, signal)).imageInput) throw imageInputUnsupported(displayIn((await gatewayListing(signal)).views, session.model));
  };

  const issueOf = async (session: Session, body: CreateRunBody, signal: AbortSignal): Promise<IssueRead | undefined> => {
    if (body.issue === undefined) return undefined;
    if (body.mandate?.profile === undefined) {
      throw invalidRequest('a run from an issue runs under a named mandate: name one of the mandates declared under mandates in the user settings', 'mandate');
    }
    return deps.issues.read(body.issue.url, signal);
  };

  const attachedTo = async (session: Session, body: CreateRunBody, signal: AbortSignal): Promise<AttachedMentions> => {
    if (body.attachMentions !== true || mentionsOf(body.input).length === 0) return { attachments: [], images: [] };
    const capabilities = await capabilitiesOf(session, signal);
    return deps.userInput.attach(session, body.input, { ceiling: capabilities.contextWindow - outputReserveFor(capabilities), imageInput: capabilities.imageInput, signal });
  };

  const refuseDeniedConditions = async (session: Session, mandate: Mandate | undefined, signal: AbortSignal): Promise<void> => {
    const conditions = mandate?.completion?.conditions ?? [];
    if (conditions.length === 0) return;
    const rules = await deps.permissionRules(session, signal);
    for (const condition of conditions) {
      const rule = denyingRuleFor(rules, knownValue(session.permissionMode, `the permission mode of session ${session.id}`), shellCommandSubject(condition.command));
      if (rule !== undefined) {
        throw invalidRequest(`the completion condition ${JSON.stringify(condition.command)} is denied by the permission rule ${rule.text} (${rule.origin}: ${rule.source})`, 'mandate');
      }
    }
  };

  const standingOfGateway = async (signal: AbortSignal): Promise<GatewayStanding> => {
    try {
      return await deps.gatewayStanding(signal);
    } catch (error) {
      signal.throwIfAborted();
      throw serviceUnavailable('gateway_unavailable', `The models cannot be reached, and the supervisor of the daemon could not be asked why: ${error instanceof Error ? error.message : String(error)}. The request was not run; send it again.`);
    }
  };

  const listingUnlessRestarting = async (signal: AbortSignal): Promise<ModelListing | undefined> => {
    try {
      return await deps.modelListing(signal);
    } catch (error) {
      if (!isGatewayUnavailable(error)) throw listingReadFailure(error);
      const standing = await standingOfGateway(signal);
      if (standing.kind === 'given-up') throw gatewayGivenUp(standing.state);
      return undefined;
    }
  };

  const admittedTermsOf = async (session: Session, request: RunTermsRequest, signal: AbortSignal): Promise<RunTerms> => {
    await sessionSettingsOf(session.cwd, signal);
    const listing = await listingUnlessRestarting(signal);
    const sessionModel = listing === undefined ? undefined : resolveStoredModelRef(storedModelRef(session.model), listing.views);
    if (listing !== undefined && sessionModel === undefined) throw modelNotConfigured(sessionModelNotConfiguredText(session.model));
    const { delegation } = deps;
    const terms = await runTermsOf({
      request,
      defaults: deps.defaults,
      settings: delegation === undefined ? {} : await settingsThrough(() => delegation.settings(signal)),
      ...(delegation === undefined ? {} : { project: () => projectMandateOf(delegation, session.cwd, signal) }),
      billing: async () => {
        if (sessionModel === undefined) throw pricesWhileRestarting();
        if (delegation === undefined) return { metered: false, priced: false };
        return delegation.chainBilling(sessionModel.canon, signal);
      },
    });
    await refuseDeniedConditions(session, terms.mandate, signal);
    return terms;
  };

  const reportedView = async (runId: string, signal: AbortSignal) => {
    const { report } = await store.journalFacts.report({ runId }, signal);
    return { ...toRunView(requireRun(runId)), report };
  };

  const createRun: Handler = async (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    requireRootSession(session);
    const idempotencyKey = parseIdempotencyKey(context.req.header('idempotency-key') ?? null);
    const parsed = await readJson(context.req.raw, JSON_MEDIA_TYPES, PROMPT_BODY_MAX_BYTES);
    const body = validateBody<CreateRunBody>('CreateRunRequest', parsed);
    refuseOversizeImages(body.images);
    const idempotency = idempotencyKey === undefined ? undefined : { idempotencyKey, requestDigest: sha256Hex(canonicalJson(parsed)) };
    const replay = async (): Promise<Response | undefined> => {
      const found = idempotency === undefined ? undefined : store.findRunByIdempotencyKey(session.id, idempotency.idempotencyKey);
      if (idempotency === undefined || found === undefined) return undefined;
      if (!sameRunRequest(found, idempotency.requestDigest)) throw idempotencyKeyReused();
      return json({ run: await reportedView(found.run.id, context.req.raw.signal) }, 202, { location: `/v1/runs/${found.run.id}`, 'idempotent-replayed': 'true' });
    };
    const replayOf = async (refusal: ApiError): Promise<Response> => {
      const replayed = await replay();
      if (replayed === undefined) throw refusal;
      return replayed;
    };
    const replayWhileRefusing = (): Promise<Response> | undefined => {
      const refusal = newWorkRefusal();
      return refusal === undefined ? undefined : replayOf(refusal);
    };
    const refused = replayWhileRefusing();
    if (refused !== undefined) return refused;
    const replayed = await replay();
    if (replayed !== undefined) return replayed;
    const terms = await admittedTermsOf(
      session,
      { ...(body.mandate === undefined ? {} : { mandate: body.mandate }), ...(body.limits === undefined ? {} : { limits: body.limits }), ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }) },
      context.req.raw.signal,
    );
    const skill = body.skill === undefined ? undefined : await activationOf(session, body.skill, context.req.raw.signal);
    await requireImageInput(session, body.images, context.req.raw.signal);
    const attached = await attachedTo(session, body, context.req.raw.signal);
    const issue = await issueOf(session, body, context.req.raw.signal);
    const images = [...(body.images ?? []), ...attached.images];
    const attachments = [...attached.attachments, ...(issue === undefined ? [] : [{ type: 'forge_issue' as const, issue: issue.reference.url, content: issue.content }])];
    const refusedDuringChecks = replayWhileRefusing();
    if (refusedDuringChecks !== undefined) return refusedDuringChecks;
    const runInput = {
      input: body.input,
      ...idempotency,
      timeoutMs: terms.timeoutMs,
      limits: terms.limits,
      pins: issue === undefined ? {} : { [ISSUE_PIN]: issue.reference },
      history: body.history ?? 'inherit',
      ...(skill === undefined ? {} : { skill }),
      ...(images.length === 0 ? {} : { images }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(terms.mandate === undefined ? {} : { mandate: terms.mandate }),
    };
    const result = issue !== undefined && body.issue?.once === true ? await store.createIssueRunAndEnqueue(session.id, runInput, issue.reference.url) : await store.createRunAndEnqueue(session.id, runInput);
    if (result.kind === 'not_found') throw notFound(`session ${session.id} does not exist`);
    if (result.kind === 'key_reused') throw idempotencyKeyReused();
    if (result.kind === 'already_started') throw conflict('issue_already_started', `the issue ${body.issue?.url ?? ''} was started in this folder before, by run ${result.runId}, and starts once`);
    return json({ run: await reportedView(result.run.id, context.req.raw.signal) }, 202, {
      location: `/v1/runs/${result.run.id}`,
      ...(result.kind === 'existing' ? { 'idempotent-replayed': 'true' } : {}),
    });
  };

  const compactSession: Handler = async (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    requireRootSession(session);
    refuseNewWork();
    const body = validateBody<CompactSessionRequest>('CompactSessionRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const terms = await admittedTermsOf(session, {}, context.req.raw.signal);
    refuseNewWork();
    if (store.userShell.runActive(session.id)) throw conflict(USER_SHELL_RUN_ACTIVE_CODE, 'a run of this session is working; the compaction starts when it has ended');
    const result = await store.createRunAndEnqueue(session.id, {
      input: compactInputOf(body.instructions),
      timeoutMs: terms.timeoutMs,
      limits: terms.limits,
      pins: compactPinOf(body.instructions),
      history: 'inherit',
    });
    if (result.kind === 'not_found') throw notFound(`session ${session.id} does not exist`);
    if (result.kind === 'key_reused') throw idempotencyKeyReused();
    return json({ run: toRunView(result.run) }, 202, { location: `/v1/runs/${result.run.id}` });
  };

  const refuseRunStartedByInbox = (session: Session): void => {
    if (deps.isDraining()) throw drainingError();
    if (!store.userShell.runActive(session.id)) refuseNewWork();
  };

  const addInbox: Handler = async (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    requireRootSession(session);
    refuseRunStartedByInbox(session);
    const body = validateBody<AddInboxBody>('AddInboxRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, PROMPT_BODY_MAX_BYTES));
    refuseOversizeImages(body.images);
    await requireImageInput(session, body.images, context.req.raw.signal);
    const terms = await admittedTermsOf(session, {}, context.req.raw.signal);
    refuseRunStartedByInbox(session);
    const result = await store.inbox.add(session.id, {
      delivery: body.delivery,
      text: body.text,
      ...(body.images === undefined ? {} : { images: body.images }),
      run: { timeoutMs: terms.timeoutMs, limits: terms.limits, pins: {} },
    });
    if (result.kind === 'not_found') throw notFound(`session ${session.id} does not exist`);
    if (result.kind === 'full') throw conflict(INBOX_FULL_CODE, inboxFullMessage());
    return json({ row: inboxRowView(result.row), pending: result.pending.map(inboxRowView) }, 201);
  };

  const listInbox: Handler = (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    return json({ pending: store.inbox.list(session.id).map(inboxRowView) });
  };

  const withdrawInbox: Handler = (context) => {
    const id = context.req.param('id') ?? '';
    const result = store.inbox.withdraw(id);
    if (result.kind === 'not_found') throw notFound(`waiting message ${id} does not exist`);
    return json({ outcome: result.kind, row: inboxRowView(result.row), pending: result.pending.map(inboxRowView) });
  };

  const runSuccessor: Handler = (context) => {
    const run = requireRun(context.req.param('id') ?? '');
    const next = store.inbox.successorOf(run.id);
    return json({ successor: next === undefined ? null : toRunView(next) });
  };

  const listChildRuns: Handler = (context) => {
    const run = requireRun(context.req.param('id') ?? '');
    return json({ runs: store.listChildRuns(run.id).map(toRunView) });
  };

  const listJobs: Handler = (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    return json({ jobs: store.jobs.listForSession(session.id).map(toJobView) });
  };

  const requireRootSession = (session: Session): void => {
    if (store.rootSessionId(session.id) !== session.id) {
      throw conflict('child_session', `session ${session.id} belongs to a subagent run and takes no direct requests`);
    }
  };

  const runAnsweredBy: Handler = async (context) => json({ answeredBy: await answeredByOf(store, requireRun(context.req.param('id') ?? '').id) });

  const getRun: Handler = async (context) => json({ run: await reportedView(requireRun(context.req.param('id') ?? '').id, context.req.raw.signal) });

  const cancelRun: Handler = async (context) => {
    const id = context.req.param('id') ?? '';
    const result = await store.requestCancel(id);
    if (result.kind === 'not_found') throw notFound(`run ${id} does not exist`);
    if (result.kind === 'status_unknown') throw conflict('value_unknown', `run ${id} has a status this build does not know, so it is not cancelled by this build`);
    const settled = isTerminalStatus(result.run.status) && !result.changed;
    return json({ run: await reportedView(result.run.id, context.req.raw.signal) }, settled ? 200 : 202);
  };

  const runTrace: Handler = async (context) => {
    const run = requireRun(context.req.param('id') ?? '');
    const trace = await deps.runTrace(run.id, context.req.raw.signal);
    if (trace === undefined) throw notFound(`run ${run.id} has no recorded trace`);
    return json(trace);
  };

  const cost: Handler = async (context) => {
    const runId = context.req.query('run');
    const sessionId = context.req.query('session');
    const requestedCwd = context.req.query('cwd');
    const given = [runId, sessionId, requestedCwd].filter((value) => value !== undefined);
    if (given.length > 1) throw invalidRequest('pass at most one of run, session and cwd', 'run');
    const runsOfSession = (id: string) => store.listRuns(id).map((run) => ({ runId: run.id, sessionId: run.sessionId }));
    let runs: { runId: string; sessionId: string }[];
    let charges: ContextCharge[];
    if (runId !== undefined) {
      const run = requireRun(runId);
      runs = [{ runId: run.id, sessionId: run.sessionId }];
      charges = store.contextCharges.list({ runIds: [run.id] });
    } else if (sessionId !== undefined) {
      runs = runsOfSession(requireSession(sessionId).id);
      charges = store.contextCharges.list({ runIds: runs.map((run) => run.runId) });
    } else if (requestedCwd !== undefined) {
      const cwd = await canonicalProject(requestedCwd, 'cwd', context.req.raw.signal);
      runs = everySession({ cwd }).flatMap((session) => runsOfSession(session.id));
      charges = store.contextCharges.list({ project: cwd });
    } else {
      runs = everySession({}).flatMap((session) => runsOfSession(session.id));
      charges = store.contextCharges.list();
    }
    const format = context.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'text') throw invalidRequest('format must be json or text', 'format');
    const breakdownParam = context.req.query('breakdown');
    if (breakdownParam !== undefined && breakdownParam !== '1') throw invalidRequest('breakdown must be 1 when given', 'breakdown');
    if (breakdownParam === '1') {
      const { breakdown, text: breakdownText } = await deps.runCostBreakdown(runs, context.req.raw.signal, given.length === 0);
      if (format === 'json') return json(breakdown);
      return new Response(`${breakdownText}\n`, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const { report, text } = await deps.runCost(runs, context.req.raw.signal, given.length === 0);
    const contextCharges = contextChargesView(charges);
    if (format === 'json') return json({ ...report, contextCharges });
    const chargesText = contextChargesText(contextCharges, report.total.inputTokens + report.total.outputTokens);
    return new Response(`${text}${chargesText === '' ? '' : `\n${chargesText}`}\n`, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  };

  const listRunApprovals: Handler = async (context) => {
    const run = requireRun(context.req.param('id') ?? '');
    return json({ approvals: await store.pendingApprovalViews(run.id) });
  };

  const getApproval: Handler = async (context) => {
    const id = context.req.param('id') ?? '';
    const approval = await store.approvalView(id);
    if (approval === undefined) throw notFound(`approval ${id} does not exist`);
    return json({ approval });
  };

  const resolveApproval: Handler = async (context) => {
    const id = context.req.param('id') ?? '';
    const body = validateBody<ResolveApprovalBody>('ResolveApprovalRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const result = await store.resolveApproval(id, body.optionId);
    switch (result.kind) {
      case 'not_found':
        throw notFound(`approval ${id} does not exist`);
      case 'approval_not_pending':
        throw conflict('approval_not_pending', `approval ${id} is ${result.status}, not pending`);
      case 'request_missing':
        throw conflict('approval_not_pending', `approval ${id} has no recorded permission request`);
      case 'run_cancelled':
        throw conflict('run_cancelled', `the run of approval ${id} was cancelled`);
      case 'option_not_offered':
        throw invalidRequest(`option ${body.optionId} was not offered for approval ${id}`, 'optionId');
      case 'ok': {
        const approval = await store.approvalView(result.approval.id);
        if (approval === undefined) throw new Error(`approval ${result.approval.id} vanished after it was resolved`);
        return json({ approval, run: toRunView(result.run) });
      }
    }
  };

  const streamOf = (context: Context, source: EventSource, cursor: number, watch: (wake: () => void) => () => void): Response =>
    context.req.method === 'HEAD'
      ? new Response(null, { status: 200, headers: STREAM_HEADERS })
      : eventStreamResponse({
          source,
          cursor,
          watch,
          timers: deps.timers,
          keepAliveMs: deps.keepAliveMs,
          signals: [deps.closeSignal, deps.retireSignal, context.req.raw.signal],
          finalFrame: deps.retireFrame,
          onError: deps.onError,
        });

  const runEvents: Handler = (context) => {
    const run = requireRun(context.req.param('id') ?? '');
    const cursor = parseCursor(context.req.raw, run.lastSeq);
    const source: EventSource = {
      read: (after, limit) => {
        const current = requireRun(run.id);
        return { events: store.readRunEventStream(run.id, after, limit), endsAt: isTerminalStatus(current.status) ? current.lastSeq : undefined };
      },
      cursorOf: (event) => {
        if (!('seq' in event) || event.seq === null) throw new Error(`run ${run.id} stream read a session event`);
        return event.seq;
      },
    };
    return streamOf(context, source, cursor, (wake) => notifier.watchRun(run.id, wake));
  };

  const sessionEvents: Handler = (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    const cursor = parseCursor(context.req.raw, store.sessionMaxEventId(session.id));
    const source: EventSource = {
      read: (after, limit) => ({ events: store.readSessionEventStream(session.id, after, limit), endsAt: undefined }),
      cursorOf: (event) => event.id,
    };
    return streamOf(context, source, cursor, (wake) => notifier.watchSession(session.id, wake));
  };

  route('/v1/health', { GET: health });
  route('/v1/sessions', { GET: listSessions, POST: createSession }, { person: ['POST'] });
  route('/v1/sessions/:id', { GET: getSession, PATCH: patchSession }, { person: ['PATCH'] });
  route('/v1/sessions/:id/runs', { GET: listRuns, POST: createRun });
  route('/v1/sessions/:id/compact', { POST: compactSession });
  route('/v1/sessions/:id/skills', { GET: listSkills });
  route('/v1/sessions/:id/agents', { GET: listAgents });
  route('/v1/sessions/:id/jobs', { GET: listJobs });
  route('/v1/sessions/:id/events', { GET: sessionEvents });
  route('/v1/sessions/:id/inbox', { GET: listInbox, POST: addInbox });
  route('/v1/inbox/:id/withdraw', { POST: withdrawInbox });
  route('/v1/runs/:id/successor', { GET: runSuccessor });
  route('/v1/runs/:id', { GET: getRun });
  route('/v1/runs/:id/answered-by', { GET: runAnsweredBy });
  route('/v1/runs/:id/children', { GET: listChildRuns });
  route('/v1/runs/:id/cancel', { POST: cancelRun });
  route('/v1/runs/:id/trace', { GET: runTrace });
  route('/v1/cost', { GET: cost });
  route('/v1/runs/:id/approvals', { GET: listRunApprovals });
  route('/v1/runs/:id/events', { GET: runEvents });
  route('/v1/approvals/:id', { GET: getApproval, POST: resolveApproval }, { person: ['POST'] });
  registerReportRoutes(route, { store, now: () => deps.clock.now(), maxBodyBytes: deps.maxBodyBytes, reportCost: deps.reportCost, runTraceContent: deps.runTraceContent, recomputeFacts: deps.recomputeFacts });
  registerTrustRoutes(route, { store, maxBodyBytes: deps.maxBodyBytes });
  registerMemoryRoutes(route, {
    store,
    views: createRecordViews({ store, evidenceRun: deps.evidenceRun }),
    evidenceRun: deps.evidenceRun,
    skillFiles: deps.skillFiles,
    platform: deps.platform,
    maxBodyBytes: deps.maxBodyBytes,
    closeSignal: deps.closeSignal,
    home: deps.home,
    refuseWhileRetiring,
  });
  registerGuidelineRoutes(route, { store, maxBodyBytes: deps.maxBodyBytes });
  registerRuleRoutes(route, {
    store,
    clock: deps.clock,
    modelListing: deps.modelListing,
    modelCapabilities: deps.modelCapabilities,
    maxBodyBytes: deps.maxBodyBytes,
    refuseWhileRetiring,
    policyVerification: deps.policyVerification,
  });
  registerMarkerRoutes(route, { markerDirectories: deps.ignorableMarkerDirectories, owners: deps.markerOwners, files: deps.files });
  registerUserShellRoutes(route, { store, userInput: deps.userInput, maxBodyBytes: deps.maxBodyBytes, closeSignal: deps.closeSignal });
  registerInputRoutes(route, { store, mcp: deps.mcp, maxBodyBytes: deps.maxBodyBytes, closeSignal: deps.closeSignal, refuseWhileRetiring });

  app.notFound(() => errorResponse(notFound('no such route')));
  app.onError((error, context) => {
    if (isAbortOf(error, context.req.raw.signal)) return new Response(null, { status: CLIENT_CLOSED_REQUEST_STATUS });
    if (error instanceof ApiError) return errorResponse(error);
    if (error instanceof JournalThreadError) return errorResponse(contributionUnavailable(error.message));
    if (error instanceof GatewayRequestError && error.status >= 400 && error.status < 600) return errorResponse(gatewayAnswer({ status: error.status, type: error.type, code: error.code, message: error.message }));
    deps.onError(error);
    return internalErrorResponse();
  });

  return app;
};

