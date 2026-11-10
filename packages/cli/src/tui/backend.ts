import type { MomongaPaths } from '@momonga/foundation';
import { currentSocketResolver, findProgramOnPath, systemTiming } from '@momonga/foundation';
import { LOCAL_SERVER_CANDIDATES } from '@momonga/protocol';
import type { AddRuleRequest, ElicitationAnswerRecord, LocalServerDetection, GatewayHealth, GoverningFactView, ImageAttachment, MemoryView, MomongaModelEntry, PermissionMode, RuleAddResponse, SkillsResponse } from '@momonga/protocol';
import { addModelConnection, loadUserSettings } from '@momonga/config';
import type { ModelConnection, WrittenConnection } from '@momonga/config';
import { createGatewayClient } from '../client/gateway-client.ts';
import type { GatewayClient, PlanGatewayClient } from '../client/gateway-client.ts';
import { withIdentityReadFetch } from '../network.ts';
import { localManagedPorts } from '../local-managed-ports.ts';
import { loopbackSignInListener } from '../plan/sign-in.ts';
import type { SandboxKind, SignInListener, SignInWaitTimers, StartSignInListener } from '../plan/sign-in.ts';
import { dismissNotice, readDismissedNotices } from './dismissed-notices.ts';
import type { DismissedNotices } from './dismissed-notices.ts';
import type { MemoryFilter, RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import type { RunView, SessionView, TrustView } from '../client/views.ts';
import type { HistoryStore } from '../history-store.ts';
import { daemonReadyBoundMs, ensureDaemon, restoreDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { followRun } from '../run/follow.ts';
import { continuedSession, hasRun, newestFirst, resolveSession } from '../run/resolve-session.ts';
import type { BusyInbox } from './busy-input.ts';
import type { NoticeSource } from './notices.ts';
import { createClipboardPrograms } from './screen/clipboard-host.ts';
import type { ClipboardPrograms } from './screen/clipboard-host.ts';
import { copyThroughRoutes } from './screen/clipboard.ts';
import type { CopyOutcome } from './screen/clipboard.ts';
import { readImageAttachment } from '../images.ts';
import { autoModeConfigured, connectRuntime, environmentSnapshot } from '../run/open-session.ts';
import type { SessionOptions } from '../run/open-session.ts';

export type FollowHandlers = {
  onEvent(frame: RunEventFrame): void;
  onChildEvent(frame: RunEventFrame, agent: string): void;
  onChildStarted(agent: string, runId: string): void;
  onChildEnded(agent: string, runId: string): void;
  onReconnecting(attempt: number): void;
};

export type ListedSession = { id: string; createdAt: number; runs: number; firstPrompt: string };

export type StartRunOptions = { skill?: string; images?: readonly ImageAttachment[] };

export type { SandboxKind, SignInListener, StartSignInListener };

export type TuiBackend = {
  readonly cwd: string;
  boot(): Promise<TrustView>;
  decideTrust(decision: 'trusted' | 'untrusted'): Promise<void>;
  openSession(modelAlias?: string, permissionMode?: PermissionMode): Promise<SessionView>;
  resumeSession(id: string): Promise<SessionView>;
  continueSession(): Promise<SessionView>;
  sessions(): Promise<readonly ListedSession[]>;
  runs(): Promise<readonly RunView[]>;
  setMode(mode: PermissionMode): Promise<SessionView>;
  models(): Promise<readonly MomongaModelEntry[]>;
  setModel(modelAlias: string): Promise<SessionView>;
  autoModeAvailable(): Promise<boolean>;
  startRun(text: string, history: 'inherit' | 'fresh', options?: StartRunOptions): Promise<RunView>;
  follow(runId: string, handlers: FollowHandlers): Promise<RunView>;
  cancel(runId: string): Promise<void>;
  readonly inbox: BusyInbox;
  resolveApproval(approvalId: string, optionId: string): Promise<void>;
  resolveElicitation(inputId: string, responses: Readonly<Record<string, ElicitationAnswerRecord>>): Promise<void>;
  openUrl(url: URL, watch: AbortSignal | undefined, onFailure: (message: string) => void): void;
  copyToClipboard(text: string): Promise<CopyOutcome>;
  skills(): Promise<SkillsResponse>;
  memories(filter?: MemoryFilter): Promise<MemoryView[]>;
  memory(id: string): Promise<MemoryView>;
  deleteMemory(id: string): Promise<void>;
  memoryHistory(id: string): Promise<MemoryView[]>;
  rules(): Promise<GoverningFactView[]>;
  addRule(request: AddRuleRequest): Promise<RuleAddResponse>;
  retireRule(id: string): Promise<GoverningFactView>;
  ruleHistory(id: string): Promise<GoverningFactView[]>;
  ignoreMarker(name: string): Promise<void>;
  model(): Promise<MomongaModelEntry>;
  startupNotices(): Promise<readonly string[]>;
  readImage(file: string): Promise<ImageAttachment>;
  loadHistory(): Promise<readonly string[]>;
  recordHistory(text: string): Promise<void>;
  readonly plan: PlanGatewayClient;
  health(): Promise<GatewayHealth>;
  sandbox(): Promise<SandboxKind>;
  startSignInListener: StartSignInListener;
  signInTimers: SignInWaitTimers;
  detectLocalServers(typed: readonly string[]): Promise<readonly LocalServerDetection[]>;
  addModelConnection(connection: ModelConnection): Promise<WrittenConnection>;
  dismissedNotices(): Promise<DismissedNotices>;
  dismissNotice(key: string): Promise<void>;
  close(): Promise<void>;
};

export const createTuiBackend = (
  ports: CliPorts,
  paths: MomongaPaths,
  options: SessionOptions,
  history: HistoryStore,
  noticeSources: readonly NoticeSource[],
  clipboard: ClipboardPrograms = createClipboardPrograms(),
): TuiBackend => {
  let client: RuntimeClient | undefined;
  let session: SessionView | undefined;
  const closing = new AbortController();
  const stopNotices: string[] = [];
  const onNotice = (message: string): void => void stopNotices.push(message);

  const runtime = (): RuntimeClient => {
    if (client === undefined) throw new Error('the daemon connection is not open yet');
    return client;
  };

  const current = (): SessionView => {
    if (session === undefined) throw new Error('the session is not open yet');
    return session;
  };

  const withGateway = async <T>(use: (gateway: GatewayClient) => Promise<T>): Promise<T> => {
    const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
    try {
      return await use(gateway);
    } finally {
      await gateway.close();
    }
  };

  const conversationRuns = async (sessionId: string): Promise<RunView[]> => (await runtime().listRuns(sessionId)).filter((run) => run.parentRunId === null).sort((left, right) => left.ordinal - right.ordinal);

  const firstPromptOf = async (runId: string): Promise<string> => {
    const reading = new AbortController();
    try {
      for await (const frame of runtime().streamEvents(runId, { signal: AbortSignal.any([closing.signal, reading.signal]) })) return frame.data.type === 'user.message' ? frame.data.text : '';
      return '';
    } finally {
      reading.abort();
    }
  };

  const listed = async (stored: SessionView): Promise<ListedSession> => {
    const runs = await conversationRuns(stored.id);
    const [first] = runs;
    return { id: stored.id, createdAt: stored.createdAt, runs: runs.length, firstPrompt: first === undefined ? '' : await firstPromptOf(first.id) };
  };

  const adopt = (view: SessionView): SessionView => {
    session = view;
    return view;
  };

  const plan: PlanGatewayClient = {
    accounts: () => withGateway((gateway) => gateway.plan.accounts()),
    signInBegin: (request) => withGateway((gateway) => gateway.plan.signInBegin(request)),
    signInComplete: (request) => withGateway((gateway) => gateway.plan.signInComplete(request)),
    signInCancel: (request) => withGateway((gateway) => gateway.plan.signInCancel(request)),
    signOut: (request) => withGateway((gateway) => gateway.plan.signOut(request)),
    setActive: (request) => withGateway((gateway) => gateway.plan.setActive(request)),
    resume: (account, request) => withGateway((gateway) => gateway.plan.resume(account, request)),
    resetHost: () => withGateway((gateway) => gateway.plan.resetHost()),
    accountModels: (account, request) => withGateway((gateway) => gateway.plan.accountModels(account, request)),
    addTarget: (account, request) => withGateway((gateway) => gateway.plan.addTarget(account, request)),
  };

  return {
    cwd: ports.cwd,
    plan,
    health: () => withGateway((gateway) => gateway.health()),
    sandbox: async () => (await runtime().health()).sandbox,
    startSignInListener: loopbackSignInListener(closing.signal),
    signInTimers: systemTiming,
    detectLocalServers: async (typed) => {
      const { detectLocalServers } = await import('@momonga/gateway');
      const { settings } = await loadUserSettings({ home: paths.home });
      return withIdentityReadFetch(ports, closing.signal, (fetch) =>
        detectLocalServers({ candidates: LOCAL_SERVER_CANDIDATES, typed, signal: closing.signal, fetch, ...localManagedPorts(settings.models.servers, ports) }),
      );
    },
    addModelConnection: (connection) => addModelConnection(paths.home, paths.settingsFile, connection),
    dismissedNotices: () => readDismissedNotices(ports.files, paths.state, onNotice),
    dismissNotice: (key) => dismissNotice(ports.files, paths.state, key, new Date(ports.clock.now())),
    boot: async () => {
      await ensureDaemon(ports, paths, { signal: closing.signal, onNotice });
      client = connectRuntime(paths);
      return client.trust(ports.cwd);
    },
    decideTrust: async (decision) => {
      await runtime().setTrust(ports.cwd, decision);
    },
    openSession: async (modelAlias, permissionMode) => {
      const chosenAlias = modelAlias ?? options.modelAlias;
      const chosenMode = permissionMode ?? options.permissionMode;
      const created = await runtime().createSession({
        cwd: ports.cwd,
        env: await environmentSnapshot(ports),
        ...(chosenMode === undefined ? {} : { permissionMode: chosenMode }),
        ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
        ...(chosenAlias === undefined ? {} : { modelAlias: chosenAlias }),
      });
      return adopt(created.session);
    },
    resumeSession: async (id) => adopt(await resolveSession(runtime(), ports.cwd, id)),
    continueSession: async () => adopt(await continuedSession(runtime(), ports.cwd)),
    sessions: async () => {
      const found: ListedSession[] = [];
      for (const stored of newestFirst((await runtime().listSessions(ports.cwd)).filter(hasRun))) {
        if (stored.id !== session?.id) found.push(await listed(stored));
      }
      return found;
    },
    runs: () => conversationRuns(current().id),
    setMode: async (mode) => {
      session = await runtime().setPermissionMode(current().id, mode);
      return session;
    },
    models: () => withGateway((gateway) => gateway.models()),
    setModel: async (modelAlias) => {
      session = await runtime().setModelAlias(current().id, modelAlias);
      return session;
    },
    autoModeAvailable: () => autoModeConfigured(ports),
    startRun: async (text, history, runOptions = {}) =>
      (await runtime().createRun(current().id, text, { history, ...runOptions })).run,
    follow: async (runId, handlers) =>
      followRun({
        client: runtime(),
        clock: ports.clock,
        random: ports.random,
        runId,
        reconnectBoundMs: await daemonReadyBoundMs(),
        restoreConnection: restoreDaemon(ports, paths, onNotice),
        onEvent: handlers.onEvent,
        onChildEvent: handlers.onChildEvent,
        onChildStarted: handlers.onChildStarted,
        onChildEnded: handlers.onChildEnded,
        onReconnecting: handlers.onReconnecting,
        signal: closing.signal,
      }),
    cancel: async (runId) => {
      await runtime().cancel(runId);
    },
    inbox: {
      add: (delivery, text, images) => runtime().inboxAdd(current().id, delivery, text, images),
      withdraw: (id) => runtime().inboxWithdraw(id),
      list: () => runtime().inboxList(current().id),
      successor: (runId) => runtime().runSuccessor(runId),
    },
    resolveApproval: async (approvalId, optionId) => {
      await runtime().resolveApproval(approvalId, optionId);
    },
    resolveElicitation: async (inputId, responses) => {
      await runtime().resolveElicitation(inputId, responses);
    },
    openUrl: (url, watch, onFailure) => ports.openUrl(url, watch === undefined ? closing.signal : AbortSignal.any([closing.signal, watch]), onFailure),
    copyToClipboard: async (text) => {
      const terminal = ports.terminal;
      if (terminal === undefined) throw new Error('the clipboard request needs a terminal');
      return copyThroughRoutes({ env: ports.env, findProgram: (name) => findProgramOnPath(name, ports.env), pipe: clipboard.pipe, writeTerminal: (sequence) => void terminal.stdout.write(sequence) }, text);
    },
    skills: () => runtime().skills(current().id),
    memories: (filter) => runtime().memories(filter),
    memory: (id) => runtime().memory(id),
    deleteMemory: (id) => runtime().deleteMemory(id),
    memoryHistory: (id) => runtime().memoryHistory(id),
    rules: () => runtime().rules(current().cwd),
    addRule: (request) => runtime().addRule(request),
    retireRule: (id) => runtime().retireRule(id),
    ruleHistory: (id) => runtime().ruleHistory(id),
    ignoreMarker: (name) => runtime().ignoreMarker(name),
    model: () => withGateway((gateway) => gateway.modelOf(current().modelAlias)),
    startupNotices: async () => [...stopNotices.splice(0), ...(await Promise.all(noticeSources.map((source) => source({ runtime: runtime(), session: current() })))).flat()],
    readImage: (file) => readImageAttachment(ports.files, ports.cwd, file),
    loadHistory: () => history.load(),
    recordHistory: (text) => history.append(text),
    close: async () => {
      closing.abort();
      clipboard.stop();
      await client?.close();
    },
  };
};
