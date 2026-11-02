import { PROTOCOL_VERSION, RequestError, agent } from '@agentclientprotocol/sdk';
import type { AgentApp, AgentConnection, RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk';
import type { ElicitationAnswerRecord, PermissionMode } from '@momonga/protocol';
import type { RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import { RunApiError } from '../client/runtime-client.ts';
import type { RunView, SessionView } from '../client/views.ts';
import { availableCommandsOf } from './commands.ts';
import { elicitationAnswerOf, elicitationRequestOf } from './elicitation.ts';
import { createMapperState, mapRunEvent, noticeUpdate } from './events.ts';
import type { ClientFeatures, Effect, MapperState, Phase } from './events.ts';
import { mcpServersOf } from './mcp-servers.ts';
import { modeStateOf, selectableModeOf } from './modes.ts';
import { promptInputOf } from './prompt-input.ts';
import { stopReasonOf } from './stop-reason.ts';
import { createOrderedQueue, createTaskGroup } from './tasks.ts';
import type { OrderedQueue, TaskGroup } from './tasks.ts';

export type FollowRequest = {
  runId: string;
  onEvent(frame: RunEventFrame): void;
  signal: AbortSignal;
};

export type AcpDeps = {
  version: string;
  runtime: RuntimeClient;
  contextWindowOf(modelAlias: string): Promise<number>;
  environment(): Promise<Record<string, string>>;
  canonicalCwd(cwd: string): string;
  daemonReady(): Promise<void>;
  follow(request: FollowRequest): Promise<RunView>;
  afterResponse(): Promise<void>;
  report(message: string): void;
};

type Turn = { runId: string | undefined; cancelRequested: boolean };

type BridgeSession = {
  readonly id: string;
  readonly modelAlias: string;
  readonly bypassAllowed: boolean;
  permissionMode: PermissionMode;
  skillNames: readonly string[];
  readonly queue: OrderedQueue;
  readonly tasks: TaskGroup;
  readonly mapper: MapperState;
  readonly pendingRequests: Map<string, AbortController>;
  readonly lifetime: AbortController;
  contextWindow: Promise<number> | undefined;
  turn: Turn | undefined;
};

const REQUEST_CANCELLED = -32800;

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

const featuresOf = (
  capabilities: { session?: { notices?: unknown; compaction?: unknown } | null; elicitation?: { form?: unknown; url?: unknown } | null } | undefined,
): ClientFeatures => ({
  notices: capabilities?.session?.notices != null,
  compaction: capabilities?.session?.compaction != null,
  elicitation: { form: capabilities?.elicitation?.form != null, url: capabilities?.elicitation?.url != null },
});

export const createAcpAgent = (deps: AcpDeps): AgentApp => {
  const app = agent({ name: 'momonga' });
  const sessions = new Map<string, BridgeSession>();
  let connection: AgentConnection | undefined;
  let features: ClientFeatures | undefined;

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

  const contextWindowOf = (session: BridgeSession): Promise<number> => (session.contextWindow ??= deps.contextWindowOf(session.modelAlias));

  const askPermission = async (session: BridgeSession, effect: Extract<Effect, { kind: 'permission' }>): Promise<void> => {
    await session.queue.settled();
    const approval = await deps.runtime.getApproval(effect.approvalId);
    if (approval.status !== 'pending') return;
    const controller = new AbortController();
    session.pendingRequests.set(effect.approvalId, controller);
    try {
      const request: RequestPermissionRequest = {
        sessionId: session.id,
        toolCall: effect.toolCall,
        options: effect.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      };
      const response = await peer().request('session/request_permission', request, { cancellationSignal: controller.signal });
      if (response.outcome.outcome === 'cancelled') return;
      await deps.runtime.resolveApproval(effect.approvalId, response.outcome.optionId);
    } catch (error) {
      if (error instanceof RequestError && error.code === REQUEST_CANCELLED && controller.signal.aborted) return;
      if (error instanceof RunApiError && error.code === 'approval_not_pending') return;
      throw error;
    } finally {
      session.pendingRequests.delete(effect.approvalId);
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
    await session.queue.settled();
    const view = await deps.runtime.getElicitation(effect.inputId);
    if (view.status !== 'pending') return;
    const controller = new AbortController();
    session.pendingRequests.set(effect.inputId, controller);
    try {
      const responses: Record<string, ElicitationAnswerRecord> = {};
      for (const request of effect.requests) responses[request.key] = await answerElicitation(session, effect, request, controller.signal);
      await deps.runtime.resolveElicitation(effect.inputId, responses);
    } catch (error) {
      if (error instanceof RequestError && error.code === REQUEST_CANCELLED && controller.signal.aborted) return;
      if (error instanceof RunApiError && error.code === 'approval_not_pending') return;
      throw error;
    } finally {
      session.pendingRequests.delete(effect.inputId);
    }
  };

  const dispatch = (session: BridgeSession, effect: Effect): void => {
    switch (effect.kind) {
      case 'update':
        send(session, effect.update);
        return;
      case 'usage':
        session.queue.enqueue(async () => {
          const size = await contextWindowOf(session);
          await peer().notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'usage_update', used: effect.used, size } });
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

  const handleFrame = (session: BridgeSession, frame: RunEventFrame, replayThrough: number): void => {
    const event = frame.data;
    const phase: Phase = 'seq' in event && event.seq <= replayThrough ? 'history' : 'live';
    for (const effect of mapRunEvent(event, phase, session.mapper, clientFeatures())) dispatch(session, effect);
  };

  const followInto = (session: BridgeSession, runId: string, replayThrough: number, onCaughtUp?: () => void): Promise<RunView> =>
    deps.follow({
      runId,
      signal: session.lifetime.signal,
      onEvent: (frame) => {
        handleFrame(session, frame, replayThrough);
        if (frame.data.type !== 'mode.changed' && frame.data.seq >= replayThrough) onCaughtUp?.();
      },
    });

  const replayRun = async (session: BridgeSession, run: RunView): Promise<void> => {
    const caughtUp = Promise.withResolvers<void>();
    if (run.lastSeq === 0) caughtUp.resolve();
    const finished = followInto(session, run.id, run.lastSeq, () => caughtUp.resolve()).then(
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
    const session: BridgeSession = {
      id: view.id,
      modelAlias: view.modelAlias,
      bypassAllowed: view.bypassAllowed,
      permissionMode: view.permissionMode,
      skillNames: [],
      queue: createOrderedQueue(),
      tasks: createTaskGroup((error) => {
        deps.report(`session ${view.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        lifetime.abort(error);
      }),
      mapper: createMapperState(),
      pendingRequests: new Map(),
      lifetime,
      contextWindow: undefined,
      turn: undefined,
    };
    sessions.set(view.id, session);
    return session;
  };

  const announceCommands = async (session: BridgeSession): Promise<void> => {
    const { skills } = await deps.runtime.skills(session.id);
    session.skillNames = skills.map((skill) => skill.name);
    await deps.afterResponse();
    send(session, { sessionUpdate: 'available_commands_update', availableCommands: availableCommandsOf(skills) });
    await session.queue.settled();
  };

  const announceAfterResponse = (session: BridgeSession): void => {
    session.tasks.run(() => announceCommands(session));
  };

  const cancelTurnOf = async (turn: Turn): Promise<void> => {
    turn.cancelRequested = true;
    if (turn.runId !== undefined) await deps.runtime.cancel(turn.runId);
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

  app.onRequest('initialize', ({ params }) => {
    if (params.protocolVersion < PROTOCOL_VERSION) throw RequestError.unsupportedProtocolVersion(params.protocolVersion, [PROTOCOL_VERSION]);
    features = featuresOf(params.clientCapabilities);
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
    const created = await viaRunApi(deps.runtime.createSession({ cwd: params.cwd, env: await deps.environment(), mcpServers }));
    const session = register(created.session);
    announceAfterResponse(session);
    return { sessionId: session.id, modes: modeStateOf(created.session) };
  });

  app.onRequest('session/load', async ({ params }) => {
    if (sessions.has(params.sessionId)) throw RequestError.invalidRequest({ sessionId: params.sessionId }, `session ${params.sessionId} is already loaded on this connection`);
    const mcpServers = mcpServersOf(params.mcpServers);
    await deps.daemonReady();
    const existing = await deps.runtime.getSession(params.sessionId).catch((error: unknown) => {
      if (error instanceof RunApiError && error.status === 404) throw RequestError.sessionNotFound(params.sessionId);
      throw error;
    });
    if (deps.canonicalCwd(params.cwd) !== existing.cwd) {
      throw RequestError.invalidParams({ cwd: params.cwd, sessionCwd: existing.cwd }, `session ${existing.id} belongs to ${existing.cwd}, not ${params.cwd}`);
    }
    const view = await viaRunApi(deps.runtime.setMcpServers(existing.id, mcpServers));
    const session = register(view);
    try {
      for (const run of await deps.runtime.listRuns(view.id)) await replayRun(session, run);
      await session.queue.settled();
    } catch (error) {
      sessions.delete(session.id);
      session.lifetime.abort(error);
      throw error;
    }
    announceAfterResponse(session);
    return { modes: modeStateOf(view) };
  });

  app.onRequest('session/set_mode', async ({ params }) => {
    const session = sessionOf(params.sessionId);
    const mode = selectableModeOf(session, params.modeId);
    const view = await viaRunApi(deps.runtime.setPermissionMode(session.id, mode));
    session.permissionMode = view.permissionMode;
    send(session, { sessionUpdate: 'current_mode_update', currentModeId: view.permissionMode });
    await session.queue.settled();
    return {};
  });

  app.onRequest('session/prompt', async ({ params, signal }) => {
    const session = sessionOf(params.sessionId);
    if (session.turn !== undefined) throw RequestError.invalidRequest({ sessionId: session.id }, `session ${session.id} is already working on a prompt`);
    const prompt = promptInputOf(params.prompt, session.skillNames);
    const turn: Turn = { runId: undefined, cancelRequested: false };
    session.turn = turn;
    const cancelTurn = (): void => {
      if (connection?.signal.aborted === true) return;
      session.tasks.run(() => cancelTurnOf(turn));
    };
    signal.addEventListener('abort', cancelTurn, { once: true });
    try {
      const { run } = await viaRunApi(deps.runtime.createRun(session.id, prompt.input, prompt.skill === undefined ? {} : { skill: prompt.skill }));
      turn.runId = run.id;
      if (turn.cancelRequested) await deps.runtime.cancel(run.id);
      let finished: RunView;
      try {
        finished = await followInto(session, run.id, 0);
      } catch (error) {
        await session.tasks.settled();
        throw error;
      }
      await session.tasks.settled();
      await session.queue.settled();
      return { stopReason: stopReasonOf(finished) };
    } finally {
      signal.removeEventListener('abort', cancelTurn);
      session.turn = undefined;
    }
  });

  app.onNotification('session/cancel', async ({ params }) => {
    const turn = sessions.get(params.sessionId)?.turn;
    if (turn !== undefined) await cancelTurnOf(turn);
  });

  return app;
};
