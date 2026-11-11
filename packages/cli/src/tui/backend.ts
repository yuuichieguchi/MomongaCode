import type { MomongaPaths } from '@momonga/foundation';
import { findProgramOnPath, resolveLayoutLocks } from '@momonga/foundation';
import type { FileCandidates } from '@momonga/foundation';
import type { AddRuleRequest, ElicitationAnswerRecord, GatewayHealth, GoverningFactView, ImageAttachment, Mandate, MemoryView, MomongaModelEntry, MomongaModelList, PermissionMode, RuleAddResponse, SkillsResponse, UserShellRecord, McpServerView } from '@momonga/protocol';
import { editSettings, readSettingsSnapshot } from '@momonga/config';
import type { SettingsLayer, SettingsOperation, SettingsSnapshot } from '@momonga/config';
import { programModelOf, serversDetector } from '../commands/models.ts';
import type { ModelsHost } from '../commands/models.ts';
import { storeSecretValue } from '../commands/secret.ts';
import { createGatewayClient } from '../client/gateway-client.ts';
import type { GatewayClient, PlanGatewayClient } from '../client/gateway-client.ts';
import { withIdentityReadFetch } from '../network.ts';
import { loopbackSignInListener } from '../plan/sign-in.ts';
import type { SandboxKind, SignInListener, SignInWaitTimers, StartSignInListener } from '../plan/sign-in.ts';
import { dismissNotice, readDismissedNotices } from './dismissed-notices.ts';
import type { DismissedNotices } from './dismissed-notices.ts';
import type { MemoryFilter, RunEventFrame, RuntimeClient, UserShellEnd } from '../client/runtime-client.ts';
import type { RunView, SessionView, TrustView } from '../client/views.ts';
import type { HistoryStore } from '../history-store.ts';
import { daemonReadyBoundMs, ensureSessionDaemon, restoreDaemon } from '../daemon/ensure-daemon.ts';
import type { NewerListener } from '../daemon/ensure-daemon.ts';
import { newerListenerOf } from '../handover/stream.ts';
import { sessionSocketResolver } from '../daemon/generations.ts';
import type { CliPorts } from '../ports.ts';
import { followRun } from '../run/follow.ts';
import { continuedSession, hasRun, newestFirst, resolveSession } from '../run/resolve-session.ts';
import type { BusyInbox } from './busy-input.ts';
import type { NoticeSource } from './notices.ts';
import { createClipboardPrograms } from './screen/clipboard-host.ts';
import type { ClipboardPrograms } from './screen/clipboard-host.ts';
import { copyThroughRoutes, readClipboardThroughRoutes } from './screen/clipboard.ts';
import type { ClipboardContent, CopyOutcome } from './screen/clipboard.ts';
import { readImageAttachment } from '../images.ts';
import { autoModeConfigured, connectSessionRuntime, environmentSnapshot } from '../run/open-session.ts';
import type { SessionOptions } from '../run/open-session.ts';

export type FollowHandlers = {
  onEvent(frame: RunEventFrame): void;
  onChildEvent(frame: RunEventFrame, agent: string): void;
  onChildStarted(agent: string, runId: string): void;
  onChildEnded(agent: string, runId: string): void;
  onReconnecting(attempt: number): void;
};

export type ListedSession = { id: string; createdAt: number; runs: number; firstPrompt: string };

export type StartRunOptions = { skill?: string; images?: readonly ImageAttachment[]; attachMentions?: boolean; mandate?: Mandate };

export type UserInputBackend = {
  fileCandidates(signal: AbortSignal): Promise<FileCandidates>;
  shell(command: string, include: boolean, onOutput: (text: string) => void): Promise<UserShellEnd>;
  stopShell(): Promise<void>;
  pendingShell(): Promise<readonly UserShellRecord[]>;
  readClipboard(signal: AbortSignal): Promise<ClipboardContent>;
};

export type { SandboxKind, SignInListener, StartSignInListener };

export type TuiBackend = {
  readonly cwd: string;
  boot(): Promise<TrustView>;
  decideTrust(decision: 'trusted' | 'untrusted'): Promise<void>;
  openSession(model?: string, permissionMode?: PermissionMode): Promise<SessionView>;
  resumeSession(id: string): Promise<SessionView>;
  continueSession(): Promise<SessionView>;
  sessions(): Promise<readonly ListedSession[]>;
  runs(): Promise<readonly RunView[]>;
  setMode(mode: PermissionMode): Promise<SessionView>;
  models(): Promise<readonly MomongaModelEntry[]>;
  setModel(model: string): Promise<SessionView>;
  autoModeAvailable(): Promise<boolean>;
  startRun(text: string, history: 'inherit' | 'fresh', options?: StartRunOptions): Promise<RunView>;
  compact(instructions?: string): Promise<RunView>;
  follow(runId: string, handlers: FollowHandlers): Promise<RunView>;
  cancel(runId: string): Promise<void>;
  readonly inbox: BusyInbox;
  readonly userInput: UserInputBackend;
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
  modelList(): Promise<MomongaModelList>;
  modelsHost(signal: AbortSignal, onWarning: (message: string) => void): ModelsHost;
  storeSecret(name: string, value: string, signal: AbortSignal): Promise<void>;
  dismissedNotices(): Promise<DismissedNotices>;
  dismissNotice(key: string): Promise<void>;
  settings(): Promise<SettingsSnapshot>;
  editSettings(layer: SettingsLayer, operation: SettingsOperation, signal: AbortSignal): Promise<void>;
  mcpServers(): Promise<readonly McpServerView[]>;
  initInstruction(): Promise<string>;
  close(): Promise<void>;
};

export const createTuiBackend = (
  ports: CliPorts,
  paths: MomongaPaths,
  options: SessionOptions,
  history: HistoryStore,
  noticeSources: readonly NoticeSource[],
  clipboard: ClipboardPrograms = createClipboardPrograms(),
  onNewer: NewerListener | undefined = newerListenerOf(ports),
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
    const gateway = createGatewayClient({ resolveSocket: sessionSocketResolver(paths, ports.version, 'gateway') });
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
    startSignInListener: loopbackSignInListener(ports.timers, closing.signal),
    signInTimers: ports.timers,
    modelList: () => withGateway((gateway) => gateway.modelList(closing.signal)),
    modelsHost: (signal, onWarning) => {
      const interrupt = AbortSignal.any([closing.signal, signal]);
      return {
        home: paths.home,
        settingsFile: paths.settingsFile,
        lock: () => resolveLayoutLocks(paths).mechanism,
        platform: ports.platform,
        interrupt,
        files: ports.files,
        listing: () => withGateway((gateway) => gateway.modelList(interrupt)),
        detect: (request) => withIdentityReadFetch(ports, request.signal, (fetch) => serversDetector(ports, fetch)(request)),
        programModel: (program, measuring) => programModelOf(ports, paths, program, measuring, onWarning),
      };
    },
    storeSecret: (name, value, signal) => storeSecretValue(ports, name, value, AbortSignal.any([closing.signal, signal])),
    dismissedNotices: () => readDismissedNotices(ports.files, paths.state, onNotice),
    dismissNotice: (key) => dismissNotice(ports.files, paths.state, key, new Date(ports.clock.now()), closing.signal),
    settings: async () => readSettingsSnapshot({ home: paths.home, projectDir: ports.cwd, trusted: (await runtime().trust(ports.cwd)).decision === 'trusted' }),
    editSettings: (layer, operation, signal) => editSettings({ home: paths.home, projectDir: ports.cwd }, layer, operation, { lock: resolveLayoutLocks(paths).mechanism, signal }),
    mcpServers: () => runtime().mcpServers(current().id),
    initInstruction: async () => (await import('@momonga/runtime')).INIT_INSTRUCTION,
    boot: async () => {
      await ensureSessionDaemon(ports, paths, { signal: closing.signal, ...(onNewer === undefined ? {} : { onNewer }) });
      client = connectSessionRuntime(ports, paths, onNewer);
      return client.trust(ports.cwd);
    },
    decideTrust: async (decision) => {
      await runtime().setTrust(ports.cwd, decision);
    },
    openSession: async (model, permissionMode) => {
      const chosen = model ?? options.model;
      const chosenMode = permissionMode ?? options.permissionMode;
      const created = await runtime().createSession({
        cwd: ports.cwd,
        env: await environmentSnapshot(ports),
        ...(chosenMode === undefined ? {} : { permissionMode: chosenMode }),
        ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
        ...(chosen === undefined ? {} : { model: chosen }),
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
    setModel: async (model) => {
      session = await runtime().setModel(current().id, model);
      return session;
    },
    autoModeAvailable: () => autoModeConfigured(ports),
    startRun: async (text, history, runOptions = {}) =>
      (await runtime().createRun(current().id, text, { history, ...runOptions })).run,
    compact: (instructions) => runtime().compact(current().id, instructions),
    follow: async (runId, handlers) =>
      followRun({
        client: runtime(),
        clock: ports.clock,
        random: ports.random,
        runId,
        reconnectBoundMs: await daemonReadyBoundMs(),
        restoreConnection: restoreDaemon(ports, paths, onNewer),
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
    userInput: {
      fileCandidates: async (signal) => {
        const { listFileCandidates } = await import('@momonga/runtime');
        return listFileCandidates({ root: ports.cwd, env: ports.env, trusted: (await runtime().trust(ports.cwd)).decision === 'trusted', signal });
      },
      shell: (command, include, onOutput) => runtime().userShell(current().id, command, include, onOutput),
      stopShell: () => runtime().stopUserShell(current().id),
      pendingShell: () => runtime().pendingUserShell(current().id),
      readClipboard: (signal) => readClipboardThroughRoutes({ env: ports.env, findProgram: (name) => findProgramOnPath(name, ports.env), capture: clipboard.capture }, signal),
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
    model: () => withGateway((gateway) => gateway.modelOf(current().model)),
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
