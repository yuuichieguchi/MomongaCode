import { PROTOCOL_VERSION, RequestError, agent } from '@agentclientprotocol/sdk';
import type { AgentApp, AgentConnection, RequestPermissionRequest, SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk';
import { isOpaqueEvent, messageOf, readMandate, readinessShownText } from '@momonga/protocol';
import type { ElicitationAnswerRecord, Mandate, ModelViews, Readiness, SkillsResponse } from '@momonga/protocol';
import type { RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import { RunApiError } from '../client/runtime-client.ts';
import { describeFailure } from '../failure.ts';
import { DAEMON_STOPPING_TEXT, isTerminalStatus } from '../run/follow.ts';
import type { RunView, SessionView } from '../client/views.ts';
import { availableCommandsOf } from './commands.ts';
import { elicitationAnswerOf, elicitationRequestOf } from './elicitation.ts';
import { createMapperState, mapChildEvent, mapRunEvent, noticeUpdate } from './events.ts';
import type { ClientFeatures, Effect, MapperState, Phase } from './events.ts';
import { mcpServersOf } from './mcp-servers.ts';
import { modeStateOf, selectableModeOf } from './modes.ts';
import { CLASSIFIER_CONFIG_ID, classifierOptionOf, modelOptionOf, selectableClassifierOf, selectableModelOf } from './models.ts';
import { promptInputOf } from './prompt-input.ts';
import { stopReasonOf } from './stop-reason.ts';
import { createOrderedQueue, createTaskGroup } from './tasks.ts';
import type { OrderedQueue, TaskGroup } from './tasks.ts';

export type FollowRequest = {
  runId: string;
  onEvent(frame: RunEventFrame): void;
  onChildEvent(frame: RunEventFrame, agent: string): void;
  onDaemonStopping(): void;
  signal: AbortSignal;
};

export type FollowSessionRequest = {
  sessionId: string;
  after: number;
  onEvent(frame: RunEventFrame): void;
  signal: AbortSignal;
};

export type AcpDeps = {
  version: string;
  runtime: RuntimeClient;
  contextWindowOf(model: string): Promise<number>;
  readinessOf(model: string): Promise<Readiness>;
  models(): Promise<ModelViews>;
  environment(): Promise<Record<string, string>>;
  classifier(): Promise<string | undefined>;
  setClassifier(value: string): Promise<void>;
  canonicalCwd(cwd: string): Promise<string>;
  daemonReady(): Promise<void>;
  retryAfterRestore<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
  follow(request: FollowRequest): Promise<RunView>;
  followSession(request: FollowSessionRequest): Promise<never>;
  report(message: string): void;
};

type Turn = { runId: string | undefined; cancelRequested: boolean };

type BridgeSession = {
  readonly id: string;
  model: string;
  readonly bypassAllowed: boolean;
  skills: Promise<SkillsResponse['skills']> | undefined;
  readonly queue: OrderedQueue;
  readonly tasks: TaskGroup;
  readonly background: TaskGroup;
  readonly mapper: MapperState;
  readonly pendingRequests: Map<string, AbortController>;
  readonly lifetime: AbortController;
  contextWindow: Promise<number> | undefined;
  readonly turns: Set<Turn>;
};

const REQUEST_CANCELLED = -32800;

type ModelListing = { kind: 'listed'; views: ModelViews } | { kind: 'unreadable'; reason: string };

const asRequestError = (error: unknown): unknown => {
  if (error instanceof RunApiError && error.status >= 400 && error.status < 500) {
    return RequestError.invalidParams({ status: error.status, ...(error.code === undefined ? {} : { code: error.code }) }, error.message);
  }
  return error;
};

const viaRunApi = async <T>(call: Promise<T>): Promise<T> => {
  try {
    return await call;
  } catch (error) {
    throw asRequestError(error);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const mandateOfMeta = (meta: unknown): { mandate?: Mandate } => {
  const own = isRecord(meta) ? meta['momonga'] : undefined;
  const declared = isRecord(own) ? own['mandate'] : undefined;
  if (declared === undefined) return {};
  try {
    return { mandate: readMandate(declared, 'the prompt') };
  } catch (error) {
    throw RequestError.invalidParams({ field: '_meta.momonga.mandate' }, error instanceof Error ? error.message : String(error));
  }
};

const featuresOf = (
  capabilities: { session?: { notices?: unknown; compaction?: unknown } | null; elicitation?: { form?: unknown; url?: unknown } | null } | undefined,
): ClientFeatures => ({
  notices: capabilities?.session?.notices != null,
  compaction: capabilities?.session?.compaction != null,
  elicitation: { form: capabilities?.elicitation?.form != null, url: capabilities?.elicitation?.url != null },
});

export type AcpHandoverState = { initialize: unknown; sessions: string[]; lastSeq: Record<string, number> };

export type AcpBridge = {
  app: AgentApp;
  quiet(): boolean;
  snapshot(): AcpHandoverState | undefined;
  adopt(state: Pick<AcpHandoverState, 'sessions' | 'lastSeq'>): Promise<void>;
  onActivity(listener: () => void): void;
};

export const createAcpBridge = (deps: AcpDeps): AcpBridge => {
  const app = agent({ name: 'momonga' });
  const sessions = new Map<string, BridgeSession>();
  let connection: AgentConnection | undefined;
  let features: ClientFeatures | undefined;
  let initialize: { params: unknown } | undefined;
  const initialized = Promise.withResolvers<void>();
  const lastSeq = new Map<string, number>();
  const activityListeners = new Set<() => void>();

  const active = (): void => {
    for (const listener of [...activityListeners]) listener();
  };

  const liveSessions = (): BridgeSession[] => [...sessions.values()].filter((session) => !session.lifetime.signal.aborted);

  const quiet = (): boolean => initialize !== undefined && liveSessions().every((session) => session.turns.size === 0 && session.pendingRequests.size === 0);

  const peer = (): AgentConnection['client'] => {
    if (connection === undefined) throw new Error('the ACP connection is not open');
    return connection.client;
  };

  const clientFeatures = (): ClientFeatures => {
    if (features === undefined) throw new Error('the client has not been initialized');
    return features;
  };

  const sessionOf = (sessionId: string): BridgeSession => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw RequestError.sessionNotFound(sessionId);
    if (session.lifetime.signal.aborted) throw session.lifetime.signal.reason;
    return session;
  };

  const send = (session: BridgeSession, update: SessionUpdate): void => {
    session.queue.enqueue(() => peer().notify('session/update', { sessionId: session.id, update }));
  };

  const contextWindowOf = async (session: BridgeSession): Promise<number> => {
    const reading = (session.contextWindow ??= deps.contextWindowOf(session.model));
    try {
      return await reading;
    } catch (error) {
      if (session.contextWindow === reading) session.contextWindow = undefined;
      throw error;
    }
  };

  let readinessNotices = 0;

  let contextWindowNotices = 0;

  const usageUpdateOf = async (session: BridgeSession, used: number): Promise<SessionUpdate> => {
    try {
      return { sessionUpdate: 'usage_update', used, size: await contextWindowOf(session) };
    } catch (error) {
      session.lifetime.signal.throwIfAborted();
      contextWindowNotices += 1;
      const text = messageOf('aboutModel', 'acp', { model: session.model, text: `its context window could not be read (${describeFailure(error)}), so this usage update is not shown; the next one reads it again` });
      return noticeUpdate(clientFeatures(), `${session.id}/context-window/${contextWindowNotices}`, 'warning', text);
    }
  };

  const announceReadiness = async (session: BridgeSession): Promise<void> => {
    const readiness = await deps.readinessOf(session.model);
    if (readiness.state === 'ready') return;
    readinessNotices += 1;
    send(session, noticeUpdate(clientFeatures(), `${session.id}/readiness/${readinessNotices}`, 'warning', readinessShownText(readiness, 'cli')));
  };

  const applyModel = (session: BridgeSession, model: string): void => {
    if (session.model === model) return;
    session.model = model;
    session.contextWindow = undefined;
    session.tasks.run(() => announceReadiness(session));
  };

  const listModels = async (): Promise<ModelListing> => {
    try {
      return { kind: 'listed', views: await deps.models() };
    } catch (error) {
      return { kind: 'unreadable', reason: describeFailure(error) };
    }
  };

  const optionsOf = async (views: ModelViews, session: BridgeSession): Promise<SessionConfigOption[]> => [modelOptionOf(views, session.model), classifierOptionOf(views, await deps.classifier())];

  const configOptionsOf = async (listing: ModelListing, session: BridgeSession): Promise<SessionConfigOption[]> => (listing.kind === 'listed' ? optionsOf(listing.views, session) : []);

  const sendOptions = async (session: BridgeSession): Promise<void> => {
    const listing = await listModels();
    await peer().notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'config_option_update', configOptions: await configOptionsOf(listing, session) } });
    for (const update of unreadableNoticeOf(session, listing)) await peer().notify('session/update', { sessionId: session.id, update });
  };

  const unreadableNoticeOf = (session: BridgeSession, listing: ModelListing): SessionUpdate[] =>
    listing.kind === 'listed'
      ? []
      : [noticeUpdate(clientFeatures(), `${session.id}/model-list`, 'warning', `the model option is not offered because the model list could not be read: ${listing.reason}`)];

  const durably = <T>(session: BridgeSession, operation: () => Promise<T>): Promise<T> => deps.retryAfterRestore(operation, session.lifetime.signal);

  const askPermission = async (session: BridgeSession, effect: Extract<Effect, { kind: 'permission' }>): Promise<void> => {
    const controller = new AbortController();
    session.pendingRequests.set(effect.approvalId, controller);
    try {
      await session.queue.settled();
      const approval = await durably(session, () => deps.runtime.getApproval(effect.approvalId));
      if (approval.status !== 'pending' || controller.signal.aborted) return;
      const request: RequestPermissionRequest = {
        sessionId: session.id,
        toolCall: effect.toolCall,
        options: effect.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      };
      const response = await peer().request('session/request_permission', request, { cancellationSignal: controller.signal });
      if (response.outcome.outcome === 'cancelled') return;
      const { optionId } = response.outcome;
      await durably(session, () => deps.runtime.resolveApproval(effect.approvalId, optionId));
    } catch (error) {
      if (error instanceof RequestError && error.code === REQUEST_CANCELLED && controller.signal.aborted) return;
      if (error instanceof RunApiError && error.code === 'approval_not_pending') return;
      throw error;
    } finally {
      session.pendingRequests.delete(effect.approvalId);
      active();
    }
  };

  const answerElicitation = async (
    session: BridgeSession,
    effect: Extract<Effect, { kind: 'elicitation' }>,
    request: Extract<Effect, { kind: 'elicitation' }>['requests'][number],
    signal: AbortSignal,
  ): Promise<ElicitationAnswerRecord> => {
    const features = clientFeatures();
    if (!features.elicitation[request.mode]) {
      send(session, noticeUpdate(features, `${effect.inputId}/${request.key}`, 'warning', `MCP server ${effect.server} asked for input this client cannot show: ${request.message}`));
      return { action: 'cancel' };
    }
    const response = await peer().request(
      'elicitation/create',
      elicitationRequestOf({ sessionId: session.id, toolCallId: effect.toolCallId, inputId: effect.inputId }, request),
      { cancellationSignal: signal },
    );
    return elicitationAnswerOf(response);
  };

  const askElicitation = async (session: BridgeSession, effect: Extract<Effect, { kind: 'elicitation' }>): Promise<void> => {
    const controller = new AbortController();
    session.pendingRequests.set(effect.inputId, controller);
    try {
      await session.queue.settled();
      const view = await durably(session, () => deps.runtime.getElicitation(effect.inputId));
      if (view.status !== 'pending' || controller.signal.aborted) return;
      const responses: Record<string, ElicitationAnswerRecord> = {};
      for (const request of effect.requests) responses[request.key] = await answerElicitation(session, effect, request, controller.signal);
      await durably(session, () => deps.runtime.resolveElicitation(effect.inputId, responses));
    } catch (error) {
      if (error instanceof RequestError && error.code === REQUEST_CANCELLED && controller.signal.aborted) return;
      if (error instanceof RunApiError && error.code === 'approval_not_pending') return;
      throw error;
    } finally {
      session.pendingRequests.delete(effect.inputId);
      active();
    }
  };

  const dispatch = (session: BridgeSession, effect: Effect): void => {
    switch (effect.kind) {
      case 'update':
        send(session, effect.update);
        return;
      case 'usage':
        session.queue.enqueue(async () => {
          await peer().notify('session/update', { sessionId: session.id, update: await usageUpdateOf(session, effect.used) });
        });
        return;
      case 'model':
        session.queue.enqueue(async () => {
          applyModel(session, effect.model);
          await sendOptions(session);
        });
        return;
      case 'permission':
        session.tasks.run(() => askPermission(session, effect));
        return;
      case 'elicitation':
        session.tasks.run(() => askElicitation(session, effect));
        return;
      case 'withdraw':
        session.pendingRequests.get(effect.id)?.abort();
        return;
    }
  };

  const handleFrame = (session: BridgeSession, frame: RunEventFrame, replayThrough: number, mutedThrough = 0): void => {
    const event = frame.data;
    if (isOpaqueEvent(event)) {
      if (!session.mapper.opaqueTypes.has(event.type)) deps.report(`session ${session.id}: events of type ${event.type} are not known to this client and are not shown`);
      for (const effect of mapRunEvent(event, 'live', session.mapper, clientFeatures())) dispatch(session, effect);
      active();
      return;
    }
    const seq = 'seq' in event ? event.seq : undefined;
    if ('seq' in event) lastSeq.set(event.runId, Math.max(lastSeq.get(event.runId) ?? 0, event.seq));
    const phase: Phase = seq !== undefined && seq <= replayThrough ? 'history' : 'live';
    const effects = mapRunEvent(event, phase, session.mapper, clientFeatures());
    if (seq === undefined || seq > mutedThrough) for (const effect of effects) dispatch(session, effect);
    active();
  };

  const handleChildFrame = (session: BridgeSession, frame: RunEventFrame, agent: string): void => {
    for (const effect of mapChildEvent(frame.data, agent, session.mapper, clientFeatures())) dispatch(session, effect);
  };

  const followInto = (session: BridgeSession, runId: string, replayThrough: number, onCaughtUp?: () => void, mutedThrough = 0): Promise<RunView> =>
    deps.follow({
      runId,
      signal: session.lifetime.signal,
      onChildEvent: (frame, agent) => handleChildFrame(session, frame, agent),
      onDaemonStopping: () => send(session, noticeUpdate(clientFeatures(), `${runId}/daemon-stopping`, 'info', DAEMON_STOPPING_TEXT)),
      onEvent: (frame) => {
        handleFrame(session, frame, replayThrough, mutedThrough);
        if ('seq' in frame.data && frame.data.seq >= replayThrough) onCaughtUp?.();
      },
    });

  const beginTurn = (session: BridgeSession, runId: string | undefined): Turn => {
    const turn: Turn = { runId, cancelRequested: false };
    session.turns.add(turn);
    return turn;
  };

  const endTurn = (session: BridgeSession, turn: Turn): void => {
    session.turns.delete(turn);
    active();
  };

  const replayRun = async (session: BridgeSession, run: RunView, through = run.lastSeq, mutedThrough = 0): Promise<void> => {
    const caughtUp = Promise.withResolvers<void>();
    if (through === 0) caughtUp.resolve();
    const turn = isTerminalStatus(run.status) ? undefined : beginTurn(session, run.id);
    const finished = followInto(session, run.id, through, () => caughtUp.resolve(), mutedThrough)
      .finally(() => {
        if (turn !== undefined) endTurn(session, turn);
      })
      .then(
        () => caughtUp.resolve(),
        (error: unknown) => {
          caughtUp.reject(error);
          throw error;
        },
      );
    session.tasks.run(async () => {
      await finished;
    });
    await caughtUp.promise;
  };

  const register = (view: SessionView): BridgeSession => {
    const lifetime = new AbortController();
    const failed = (error: unknown): void => {
      deps.report(`session ${view.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      lifetime.abort(error);
    };
    const session: BridgeSession = {
      id: view.id,
      model: view.model,
      bypassAllowed: view.bypassAllowed,
      skills: undefined,
      queue: createOrderedQueue(),
      tasks: createTaskGroup(failed),
      background: createTaskGroup(failed),
      mapper: createMapperState(),
      pendingRequests: new Map(),
      lifetime,
      contextWindow: undefined,
      turns: new Set(),
    };
    sessions.set(view.id, session);
    session.background.run(async () => {
      try {
        await deps.followSession({
          sessionId: view.id,
          after: view.lastEventId,
          signal: lifetime.signal,
          onEvent: (frame) => {
            if (frame.data.type === 'mode.changed' || frame.data.type === 'model.changed') handleFrame(session, frame, 0);
          },
        });
      } catch (error) {
        if (!lifetime.signal.aborted) throw error;
      }
    });
    return session;
  };

  const skillsOf = (session: BridgeSession): Promise<SkillsResponse['skills']> => (session.skills ??= durably(session, () => deps.runtime.skills(session.id)).then((listed) => listed.skills));

  const skillNamesOf = async (session: BridgeSession): Promise<string[]> => (await skillsOf(session)).map((skill) => skill.name);

  const announceCommands = async (session: BridgeSession, listing: ModelListing, opening: readonly SessionUpdate[]): Promise<void> => {
    const skills = await skillsOf(session);
    send(session, { sessionUpdate: 'available_commands_update', availableCommands: availableCommandsOf(skills) });
    for (const update of opening) send(session, update);
    for (const update of unreadableNoticeOf(session, listing)) send(session, update);
    await announceReadiness(session);
    await session.queue.settled();
  };

  const announceAfterResponse = (session: BridgeSession, listing: ModelListing, opening: readonly SessionUpdate[]): void => {
    session.tasks.run(() => announceCommands(session, listing, opening));
  };

  const cancelTurnOf = async (session: BridgeSession, turn: Turn): Promise<void> => {
    turn.cancelRequested = true;
    const { runId } = turn;
    if (runId !== undefined) await durably(session, () => deps.runtime.cancel(runId));
  };

  app.onConnect((opened) => {
    connection = opened;
    opened.signal.addEventListener(
      'abort',
      () => {
        for (const session of sessions.values()) session.lifetime.abort(new Error('the ACP connection closed'));
      },
      { once: true },
    );
  });

  const adoptSession = async (id: string, seen: Readonly<Record<string, number>>): Promise<void> => {
    await deps.daemonReady();
    const view = await deps.runtime.getSession(id);
    const session = register(view);
    await skillsOf(session);
    for (const run of await deps.runtime.listRuns(view.id)) {
      const through = seen[run.id] ?? 0;
      if (!isTerminalStatus(run.status)) await replayRun(session, run, through, through);
    }
  };

  const adopt: AcpBridge['adopt'] = async (state) => {
    await initialized.promise;
    for (const [runId, seq] of Object.entries(state.lastSeq)) lastSeq.set(runId, seq);
    for (const id of state.sessions) await adoptSession(id, state.lastSeq);
    active();
  };

  app.onRequest('initialize', ({ params }) => {
    if (params.protocolVersion < PROTOCOL_VERSION) throw RequestError.unsupportedProtocolVersion(params.protocolVersion, [PROTOCOL_VERSION]);
    features = featuresOf(params.clientCapabilities);
    initialize = { params };
    initialized.resolve();
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'momonga', title: 'MomongaCode', version: deps.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
      },
      authMethods: [],
    };
  });

  app.onRequest('session/new', async ({ params }) => {
    const mcpServers = mcpServersOf(params.mcpServers);
    await deps.daemonReady();
    const created = await viaRunApi(deps.runtime.createSession({ cwd: params.cwd, env: await deps.environment(), mcpServers, terminalUi: false }));
    const listing = await listModels();
    const session = register(created.session);
    announceAfterResponse(session, listing, created.trustNotice === undefined ? [] : [noticeUpdate(clientFeatures(), `${session.id}/trust`, 'warning', created.trustNotice)]);
    return { sessionId: session.id, modes: modeStateOf({ ...session, permissionMode: created.session.permissionMode }), configOptions: await configOptionsOf(listing, session) };
  });

  app.onRequest('session/load', async ({ params }) => {
    if (sessions.get(params.sessionId)?.lifetime.signal.aborted === false) throw RequestError.invalidRequest({ sessionId: params.sessionId }, `session ${params.sessionId} is already loaded on this connection`);
    const mcpServers = mcpServersOf(params.mcpServers);
    await deps.daemonReady();
    const existing = await deps.runtime.getSession(params.sessionId).catch((error: unknown) => {
      if (error instanceof RunApiError && error.status === 404) throw RequestError.sessionNotFound(params.sessionId);
      throw error;
    });
    if ((await deps.canonicalCwd(params.cwd)) !== existing.cwd) {
      throw RequestError.invalidParams({ cwd: params.cwd, sessionCwd: existing.cwd }, `session ${existing.id} belongs to ${existing.cwd}, not ${params.cwd}`);
    }
    const view = await viaRunApi(deps.runtime.setMcpServers(existing.id, mcpServers));
    const listing = await listModels();
    const session = register(view);
    try {
      for (const run of await deps.runtime.listRuns(view.id)) await replayRun(session, run);
      await session.queue.settled();
    } catch (error) {
      sessions.delete(session.id);
      session.lifetime.abort(error);
      throw error;
    }
    announceAfterResponse(session, listing, []);
    return { modes: modeStateOf({ ...session, permissionMode: view.permissionMode }), configOptions: await configOptionsOf(listing, session) };
  });

  app.onRequest('session/set_mode', async ({ params }) => {
    const session = sessionOf(params.sessionId);
    const mode = selectableModeOf(session, params.modeId);
    await viaRunApi(deps.runtime.setPermissionMode(session.id, mode));
    return {};
  });

  app.onRequest('session/set_config_option', async ({ params }) => {
    const session = sessionOf(params.sessionId);
    const views = await deps.models();
    if (params.configId === CLASSIFIER_CONFIG_ID) {
      await deps.setClassifier(selectableClassifierOf(views, await deps.classifier(), { configId: params.configId, value: params.value }));
      for (const other of sessions.values()) if (other !== session && !other.lifetime.signal.aborted) other.queue.enqueue(() => sendOptions(other));
      return { configOptions: await optionsOf(views, session) };
    }
    const model = selectableModelOf(views, { configId: params.configId, value: params.value });
    const view = await viaRunApi(deps.runtime.setModel(session.id, model));
    applyModel(session, view.model);
    return { configOptions: await optionsOf(views, session) };
  });

  app.onRequest('session/prompt', async ({ params, signal }) => {
    const session = sessionOf(params.sessionId);
    if (session.turns.size > 0) throw RequestError.invalidRequest({ sessionId: session.id }, `session ${session.id} is already working on a prompt`);
    const turn = beginTurn(session, undefined);
    const cancelTurn = (): void => {
      if (connection?.signal.aborted === true) return;
      session.tasks.run(() => cancelTurnOf(session, turn));
    };
    signal.addEventListener('abort', cancelTurn, { once: true });
    try {
      const prompt = promptInputOf(params.prompt, await skillNamesOf(session));
      const declared = mandateOfMeta(params._meta);
      const { run } = await viaRunApi(deps.runtime.createRun(session.id, prompt.input, { ...(prompt.skill === undefined ? {} : { skill: prompt.skill }), ...declared }));
      turn.runId = run.id;
      if (turn.cancelRequested) await durably(session, () => deps.runtime.cancel(run.id));
      let finished: RunView;
      try {
        finished = await followInto(session, run.id, 0);
      } catch (error) {
        await session.tasks.settled();
        throw error;
      }
      await session.tasks.settled();
      await session.queue.settled();
      return { stopReason: turn.cancelRequested ? 'cancelled' : stopReasonOf(finished) };
    } finally {
      signal.removeEventListener('abort', cancelTurn);
      endTurn(session, turn);
    }
  });

  app.onNotification('session/cancel', async ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session !== undefined) await Promise.all([...session.turns].map((turn) => cancelTurnOf(session, turn)));
  });

  return {
    app,
    quiet,
    snapshot: () => (initialize === undefined ? undefined : { initialize: initialize.params, sessions: liveSessions().map((session) => session.id), lastSeq: Object.fromEntries(lastSeq) }),
    adopt,
    onActivity: (listener) => {
      activityListeners.add(listener);
    },
  };
};
