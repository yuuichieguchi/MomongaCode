import { createAcpBridge } from '../src/acp/agent.ts';
import type { AcpBridge, AcpDeps, FollowRequest, FollowSessionRequest } from '../src/acp/agent.ts';
import { withReplayedInitialize } from '../src/acp/handover.ts';
import type { AgentConnection, AnyMessage } from '@agentclientprotocol/sdk';
import type { MessageStream } from '../src/acp/handover.ts';
import type { ModelViews, PublicRunEvent, SkillsResponse } from '@momonga/protocol';
import { SCRIPTED_MODEL_ID, SCRIPTED_PROVIDER, afterMicrotasks } from '@momonga/testkit';
import { RunApiError } from '../src/client/runtime-client.ts';
import type { CreatedSession, RunEventFrame, RuntimeClient } from '../src/client/runtime-client.ts';
import type { ApprovalView, ElicitationView, RunView, SessionView } from '../src/client/views.ts';
import { SESSION, runView } from './fake-backend.ts';

export type EventPayload = PublicRunEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, 'id' | 'runId' | 'sessionId' | 'seq' | 'step' | 'createdAt'> & { step?: number }
    : never
  : never;

export const frameOf = (runId: string, seq: number, payload: EventPayload): RunEventFrame & { readonly data: PublicRunEvent } => ({
  id: seq,
  event: payload.type,
  data: { id: seq, runId, sessionId: SESSION.id, seq, step: 1, createdAt: 1, ...payload } as PublicRunEvent,
});

export type Peer = {
  readonly received: readonly AnyMessage[];
  request(method: string, params: unknown): Promise<AnyMessage>;
  notify(method: string, params: unknown): Promise<void>;
  untilReceived(predicate: (message: AnyMessage) => boolean): Promise<AnyMessage>;
  answerRequests(handler: (method: string, params: unknown) => unknown): void;
  close(): Promise<void>;
};

const isRequest = (message: AnyMessage): message is AnyMessage & { id: string | number | null; method: string } => 'method' in message && 'id' in message;

const isResponseTo = (message: AnyMessage, id: number): boolean => !('method' in message) && 'id' in message && message.id === id;

export type Connectable = { connect(stream: MessageStream): AgentConnection };

export const connectPeer = (app: Connectable): Peer => {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const fromAgent = new TransformStream<AnyMessage, AnyMessage>();
  const connection = app.connect({ readable: toAgent.readable, writable: fromAgent.writable });
  const writer = toAgent.writable.getWriter();
  const received: AnyMessage[] = [];
  const listeners = new Set<() => void>();
  let handler: ((method: string, params: unknown) => unknown) | undefined;
  let nextId = 1;
  const answering = new Set<Promise<void>>();

  const answer = async (message: AnyMessage & { id: string | number | null; method: string }): Promise<void> => {
    if (handler === undefined) throw new Error(`the agent sent the request ${message.method} and the test has no handler`);
    try {
      const result = await handler(message.method, 'params' in message ? message.params : undefined);
      await writer.write({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : -32603;
      await writer.write({ jsonrpc: '2.0', id: message.id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  };

  const reader = fromAgent.readable.getReader();
  const reading = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      const message = next.value;
      received.push(message);
      if (isRequest(message)) {
        const tracked: Promise<void> = answer(message).finally(() => {
          answering.delete(tracked);
        });
        answering.add(tracked);
      }
      for (const listener of [...listeners]) listener();
    }
  })();

  const untilReceived = (predicate: (message: AnyMessage) => boolean): Promise<AnyMessage> =>
    new Promise((resolve) => {
      const check = (): boolean => {
        const found = received.find(predicate);
        if (found === undefined) return false;
        listeners.delete(check);
        resolve(found);
        return true;
      };
      if (!check()) listeners.add(check);
    });

  return {
    received,
    request: async (method, params) => {
      const id = nextId;
      nextId += 1;
      await writer.write({ jsonrpc: '2.0', id, method, params });
      return untilReceived((message) => isResponseTo(message, id));
    },
    notify: (method, params) => writer.write({ jsonrpc: '2.0', method, params }),
    untilReceived,
    answerRequests: (next) => {
      handler = next;
    },
    close: async () => {
      await writer.close();
      connection.close();
      await connection.closed;
      await reader.cancel();
      await Promise.all([reading, ...answering]);
    },
  };
};

export const resultOf = (message: AnyMessage): unknown => {
  if (!('result' in message)) throw new Error(`expected a result, got ${JSON.stringify(message)}`);
  return message.result;
};

export const errorOf = (message: AnyMessage): { code: number; message: string; data?: unknown } => {
  if (!('error' in message)) throw new Error(`expected an error, got ${JSON.stringify(message)}`);
  return message.error;
};

export const updatesOf = (received: readonly AnyMessage[]): { sessionUpdate: string; [key: string]: unknown }[] =>
  received.flatMap((message) => {
    if (!('method' in message) || message.method !== 'session/update' || typeof message.params !== 'object' || message.params === null || !('update' in message.params)) return [];
    const update = message.params.update;
    return typeof update === 'object' && update !== null && 'sessionUpdate' in update && typeof update.sessionUpdate === 'string'
      ? [{ ...update, sessionUpdate: update.sessionUpdate }]
      : [];
  });

export const labelsOf = (received: readonly AnyMessage[]): string[] =>
  received.map((message) => {
    if ('method' in message) {
      if (message.method === 'session/update') return `update:${updatesOf([message])[0]?.sessionUpdate}`;
      return message.method;
    }
    return 'result' in message ? `result:${String(message.id)}` : `error:${String(message.id)}`;
  });

export type RunScript = (request: FollowRequest) => Promise<RunView>;

export type FakeRuntime = RuntimeClient & {
  readonly calls: string[];
  called(prefix: string): Promise<void>;
  session: SessionView;
  runs: RunView[];
  skillList: SkillsResponse;
  approvalStatus: ApprovalView['status'];
  elicitationStatus: ElicitationView['status'];
  createRunResult: (input: string) => Promise<RunView>;
  failures: Map<string, Error>;
  modeChanged: ((mode: SessionView['permissionMode']) => void) | undefined;
  modelChanged: ((model: string, previousModel: string) => void) | undefined;
};

const unexpected = (name: string) => (): never => {
  throw new Error(`the test did not expect ${name}`);
};

export const approvalView = (overrides: Partial<ApprovalView> = {}): ApprovalView => ({
  id: 'approval-1',
  kind: 'permission',
  runId: 'run-1',
  callId: 'call-1',
  status: 'pending',
  options: [],
  createdAt: 1,
  reason: 'edits require approval',
  toolCall: { callId: 'call-1', name: 'Edit', title: 'Edit a.txt', kind: 'edit' },
  ...overrides,
});

export const fakeRuntime = (): FakeRuntime => {
  const calls: string[] = [];
  const waiters = new Set<() => void>();
  const record = (call: string): void => {
    calls.push(call);
    for (const waiter of [...waiters]) waiter();
  };
  const runtime: FakeRuntime = {
    calls,
    called: (prefix) =>
      new Promise((resolve) => {
        const check = (): boolean => {
          if (!calls.some((call) => call.startsWith(prefix))) return false;
          waiters.delete(check);
          resolve();
          return true;
        };
        if (!check()) waiters.add(check);
      }),
    session: SESSION,
    runs: [],
    skillList: { skills: [], warnings: [] },
    approvalStatus: 'pending',
    elicitationStatus: 'pending',
    createRunResult: async () => runView({ id: 'run-1', status: 'QUEUED' }),
    failures: new Map(),
    modeChanged: undefined,
    modelChanged: undefined,
    health: unexpected('health'),
    createSession: async (input): Promise<CreatedSession> => {
      record(`createSession ${JSON.stringify({ cwd: input.cwd, mcpServers: input.mcpServers })}`);
      return { session: runtime.session, strippedEnvKeys: [] };
    },
    getSession: async (id) => {
      record(`getSession ${id}`);
      const failure = runtime.failures.get('getSession');
      if (failure !== undefined) throw failure;
      return runtime.session;
    },
    listSessions: unexpected('listSessions'),
    listRuns: async (id) => {
      record(`listRuns ${id}`);
      return runtime.runs;
    },
    skills: async (id) => {
      record(`skills ${id}`);
      await afterMicrotasks();
      return runtime.skillList;
    },
    setMcpServers: async (id, servers) => {
      record(`setMcpServers ${id} ${JSON.stringify(servers)}`);
      return runtime.session;
    },
    setPermissionMode: async (id, mode) => {
      record(`setPermissionMode ${id} ${mode}`);
      const failure = runtime.failures.get('setPermissionMode');
      if (failure !== undefined) throw failure;
      runtime.session = { ...runtime.session, permissionMode: mode };
      runtime.modeChanged?.(mode);
      return runtime.session;
    },
    setModel: async (id, model) => {
      record(`setModel ${id} ${model}`);
      const failure = runtime.failures.get('setModel');
      if (failure !== undefined) throw failure;
      const previousModel = runtime.session.model;
      runtime.session = { ...runtime.session, model };
      runtime.modelChanged?.(model, previousModel);
      return runtime.session;
    },
    compact: async (sessionId, instructions) => {
      record(`compact ${sessionId} ${JSON.stringify(instructions ?? null)}`);
      return runView({ id: 'run-compact', status: 'QUEUED' });
    },
    createRun: async (sessionId, input, options) => {
      record(`createRun ${sessionId} ${JSON.stringify({ input, ...(options?.skill === undefined ? {} : { skill: options.skill }), ...(options?.mandate === undefined ? {} : { mandate: options.mandate }) })}`);
      const failure = runtime.failures.get('createRun');
      if (failure !== undefined) throw failure;
      return { run: await runtime.createRunResult(input), location: '/v1/runs/run-1' };
    },
    getRun: unexpected('getRun'),
    inboxAdd: unexpected('inboxAdd'),
    inboxWithdraw: unexpected('inboxWithdraw'),
    inboxList: unexpected('inboxList'),
    runSuccessor: unexpected('runSuccessor'),
    userShell: unexpected('userShell'),
    stopUserShell: unexpected('stopUserShell'),
    pendingUserShell: unexpected('pendingUserShell'),
    cancel: async (id) => {
      record(`cancel ${id}`);
      const failure = runtime.failures.get('cancel');
      if (failure !== undefined) {
        runtime.failures.delete('cancel');
        throw failure;
      }
      return { status: 202, run: runView({ id, status: 'CANCELLING' }) };
    },
    trace: unexpected('trace'),
    approvals: unexpected('approvals'),
    getApproval: async (id) => {
      record(`getApproval ${id}`);
      const failure = runtime.failures.get('getApproval');
      if (failure !== undefined) {
        runtime.failures.delete('getApproval');
        throw failure;
      }
      return approvalView({ id, status: runtime.approvalStatus });
    },
    resolveApproval: async (id, optionId) => {
      record(`resolveApproval ${id} ${optionId}`);
      const failure = runtime.failures.get('resolveApproval');
      if (failure !== undefined) throw failure;
      return { approval: approvalView({ id, status: 'resolved' }), run: runView({ status: 'RUNNING' }) };
    },
    getElicitation: async (id) => {
      record(`getElicitation ${id}`);
      return {
        id,
        runId: 'run-1',
        callId: 'call-1',
        status: runtime.elicitationStatus,
        server: 'remote',
        requests: [],
        expiresAt: 10,
        createdAt: 1,
        toolCall: { callId: 'call-1', name: 'mcp__remote__ask', title: 'Ask' },
      };
    },
    resolveElicitation: async (id, responses) => {
      record(`resolveElicitation ${id} ${JSON.stringify(responses)}`);
      const failure = runtime.failures.get('resolveElicitation');
      if (failure !== undefined) throw failure;
      return {
        elicitation: {
          id,
          runId: 'run-1',
          callId: 'call-1',
          status: 'resolved',
          server: 'remote',
          requests: [],
          expiresAt: 10,
          createdAt: 1,
          toolCall: { callId: 'call-1', name: 'mcp__remote__ask', title: 'Ask' },
        },
        run: runView({ status: 'RUNNING' }),
      };
    },
    elicitations: unexpected('elicitations'),
    agents: unexpected('agents'),
    jobs: unexpected('jobs'),
    childRuns: unexpected('childRuns'),
    mcpServers: unexpected('mcpServers'),
    mcpWarnings: unexpected('mcpWarnings'),
    startMcpAuthorization: unexpected('startMcpAuthorization'),
    mcpAuthorization: unexpected('mcpAuthorization'),
    cancelMcpAuthorization: unexpected('cancelMcpAuthorization'),
    updateSession: unexpected('updateSession'),
    folderMcpServers: unexpected('folderMcpServers'),
    startFolderMcpAuthorization: unexpected('startFolderMcpAuthorization'),
    folderMcpAuthorization: unexpected('folderMcpAuthorization'),
    cancelFolderMcpAuthorization: unexpected('cancelFolderMcpAuthorization'),
    memories: unexpected('memories'),
    lastReflection: unexpected('lastReflection'),
    memory: unexpected('memory'),
    addMemory: unexpected('addMemory'),
    deleteMemory: unexpected('deleteMemory'),
    memoryHistory: unexpected('memoryHistory'),
    acceptMemory: unexpected('acceptMemory'),
    rejectMemory: unexpected('rejectMemory'),
    restoreMemory: unexpected('restoreMemory'),
    promoteMemory: unexpected('promoteMemory'),
    rules: unexpected('rules'),
    addRule: unexpected('addRule'),
    retireRule: unexpected('retireRule'),
    ignoreMarker: unexpected('ignoreMarker'),
    ruleHistory: unexpected('ruleHistory'),
    policyGovernance: unexpected('policyGovernance'),
    policyVerify: unexpected('policyVerify'),
    guidelines: unexpected('guidelines'),
    adoptGuideline: unexpected('adoptGuideline'),
    rollbackGuideline: unexpected('rollbackGuideline'),
    recordContextCharge: unexpected('recordContextCharge'),
    reportFacts: unexpected('reportFacts'),
    reportReviews: unexpected('reportReviews'),
    storeReview: unexpected('storeReview'),
    reportCost: unexpected('reportCost'),
    reportRecompute: unexpected('reportRecompute'),
    traceContent: unexpected('traceContent'),
    cost: unexpected('cost'),
    costText: unexpected('costText'),
    runReflection: unexpected('runReflection'),
    runAnsweredBy: unexpected('runAnsweredBy'),
    costBreakdown: unexpected('costBreakdown'),
    costBreakdownText: unexpected('costBreakdownText'),
    toolResult: unexpected('toolResult'),
    trust: unexpected('trust'),
    setTrust: unexpected('setTrust'),
    clearTrust: unexpected('clearTrust'),
    trustItems: unexpected('trustItems'),
    streamEvents: unexpected('streamEvents'),
    streamSessionEvents: unexpected('streamSessionEvents'),
    close: async () => undefined,
  };
  return runtime;
};

export const modeChangedFrame = (id: number, mode: SessionView['permissionMode']): RunEventFrame => ({
  id,
  event: 'mode.changed',
  data: { id, sessionId: SESSION.id, createdAt: 1, type: 'mode.changed', mode },
});

export const modelChangedFrame = (id: number, model: string, previousModel: string): RunEventFrame => ({
  id,
  event: 'model.changed',
  data: { id, sessionId: SESSION.id, createdAt: 1, type: 'model.changed', model, previousModel },
});

export const OTHER_MODEL = 'apple/fm-large';

export const MODEL_VIEWS: ModelViews = [
  { canon: SESSION.model, provider: SCRIPTED_PROVIDER, ownName: SCRIPTED_MODEL_ID },
  { canon: OTHER_MODEL, provider: 'apple', ownName: 'fm-large' },
];

export const MODEL_OPTIONS = [
  { value: SESSION.model, name: SCRIPTED_MODEL_ID },
  { value: OTHER_MODEL, name: 'fm-large' },
];

export type Harness = {
  readonly bridge: AcpBridge;
  readonly runtime: FakeRuntime;
  readonly peer: Peer;
  readonly reports: string[];
  readonly reported: Promise<void>;
  readonly sessionStreams: readonly FollowSessionRequest[];
  scripts: Map<string, RunScript>;
  contextWindows: Map<string, number>;
  emitSessionEvent(frame: RunEventFrame): void;
  failSessionStream(error: Error): void;
};

export const startAgent = (overrides: Partial<AcpDeps> = {}, replayedInitialize?: unknown): Harness => {
  const runtime = fakeRuntime();
  const scripts = new Map<string, RunScript>();
  const contextWindows = new Map<string, number>([[SESSION.model, 8192]]);
  const reports: string[] = [];
  const firstReport = Promise.withResolvers<void>();
  const sessionStreams: FollowSessionRequest[] = [];
  const failures: ((error: Error) => void)[] = [];
  let nextEventId = 1;
  runtime.modeChanged = (mode) => {
    const request = sessionStreams.at(-1);
    if (request === undefined) throw new Error('the session event stream is not open');
    request.onEvent(modeChangedFrame(nextEventId, mode));
    nextEventId += 1;
  };
  runtime.modelChanged = (model, previousModel) => {
    const request = sessionStreams.at(-1);
    if (request === undefined) throw new Error('the session event stream is not open');
    request.onEvent(modelChangedFrame(nextEventId, model, previousModel));
    nextEventId += 1;
  };
  const deps: AcpDeps = {
    version: '9.9.9',
    runtime,
    models: async () => MODEL_VIEWS,
    contextWindowOf: async (model) => {
      const size = contextWindows.get(model);
      if (size === undefined) throw new Error(`no context window for ${model}`);
      return size;
    },
    readinessOf: async () => ({ state: 'ready' }),
    environment: async () => ({ HOME: '/h' }),
    autoModeAvailable: async () => false,
    canonicalCwd: async (cwd) => cwd,
    daemonReady: async () => undefined,
    retryAfterRestore: (operation) => operation(),
    follow: async (request) => {
      const script = scripts.get(request.runId);
      if (script === undefined) throw new Error(`no script for run ${request.runId}`);
      return script(request);
    },
    followSession: (request) =>
      new Promise<never>((_resolve, reject) => {
        sessionStreams.push(request);
        failures.push(reject);
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      }),
    report: (message) => {
      reports.push(message);
      firstReport.resolve();
    },
    ...overrides,
  };
  const bridge = createAcpBridge(deps);
  const adopting: Connectable = { connect: (stream) => bridge.app.connect(withReplayedInitialize(stream, replayedInitialize)) };
  const peer = connectPeer(replayedInitialize === undefined ? bridge.app : adopting);
  return {
    bridge,
    runtime,
    peer,
    reports,
    reported: firstReport.promise,
    sessionStreams,
    scripts,
    contextWindows,
    emitSessionEvent: (frame) => {
      const request = sessionStreams.at(-1);
      if (request === undefined) throw new Error('the session event stream is not open');
      request.onEvent(frame);
    },
    failSessionStream: (error) => {
      const fail = failures.at(-1);
      if (fail === undefined) throw new Error('the session event stream is not open');
      fail(error);
    },
  };
};

export const notFound = (what: string): RunApiError =>
  new RunApiError(`GET /v1/${what}`, 404, JSON.stringify({ error: { type: 'invalid_request_error', code: 'not_found', message: `${what} does not exist` } }));

export const conflict = (code: string, message: string): RunApiError =>
  new RunApiError('POST /v1/x', 409, JSON.stringify({ error: { type: 'invalid_request_error', code, message } }));

export const INITIALIZE = { protocolVersion: 1, clientCapabilities: {} };
