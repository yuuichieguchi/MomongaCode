import type { MomongaPaths } from '@momonga/foundation';
import type { AddRuleRequest, ElicitationAnswerRecord, GoverningFactView, ImageAttachment, MemoryView, MomongaModelEntry, PermissionMode, RuleAddResponse, SkillsResponse } from '@momonga/protocol';
import { createGatewayClient } from '../client/gateway-client.ts';
import type { MemoryFilter, RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import type { RunView, SessionView, TrustView } from '../client/views.ts';
import type { HistoryStore } from '../history-store.ts';
import { daemonReadyBoundMs, ensureDaemon, restoreDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { followRun } from '../run/follow.ts';
import type { NoticeSource } from './notices.ts';
import { readImageAttachment } from '../images.ts';
import { autoModeConfigured, connectRuntime, environmentSnapshot } from '../run/open-session.ts';
import type { SessionOptions } from '../run/open-session.ts';

export type FollowHandlers = {
  onEvent(frame: RunEventFrame): void;
  onChildEvent(frame: RunEventFrame, agent: string): void;
  onReconnecting(attempt: number): void;
};

export type StartRunOptions = { skill?: string; images?: readonly ImageAttachment[] };

export type TuiBackend = {
  readonly cwd: string;
  boot(): Promise<TrustView>;
  decideTrust(decision: 'trusted' | 'untrusted'): Promise<void>;
  openSession(): Promise<SessionView>;
  setMode(mode: PermissionMode): Promise<SessionView>;
  models(): Promise<readonly MomongaModelEntry[]>;
  setModel(modelAlias: string): Promise<SessionView>;
  autoModeAvailable(): Promise<boolean>;
  startRun(text: string, history: 'inherit' | 'fresh', options?: StartRunOptions): Promise<RunView>;
  follow(runId: string, handlers: FollowHandlers): Promise<RunView>;
  cancel(runId: string): Promise<void>;
  resolveApproval(approvalId: string, optionId: string): Promise<void>;
  resolveElicitation(inputId: string, responses: Readonly<Record<string, ElicitationAnswerRecord>>): Promise<void>;
  openUrl(url: URL): Promise<void>;
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
  close(): Promise<void>;
};

export const createTuiBackend = (
  ports: CliPorts,
  paths: MomongaPaths,
  options: SessionOptions,
  history: HistoryStore,
  noticeSources: readonly NoticeSource[],
): TuiBackend => {
  let client: RuntimeClient | undefined;
  let session: SessionView | undefined;
  const closing = new AbortController();

  const runtime = (): RuntimeClient => {
    if (client === undefined) throw new Error('the daemon connection is not open yet');
    return client;
  };

  const current = (): SessionView => {
    if (session === undefined) throw new Error('the session is not open yet');
    return session;
  };

  return {
    cwd: ports.cwd,
    boot: async () => {
      await ensureDaemon(ports, paths, { signal: closing.signal });
      client = connectRuntime(paths);
      return client.trust(ports.cwd);
    },
    decideTrust: async (decision) => {
      await runtime().setTrust(ports.cwd, decision);
    },
    openSession: async () => {
      const created = await runtime().createSession({
        cwd: ports.cwd,
        env: await environmentSnapshot(ports),
        ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
        ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
        ...(options.modelAlias === undefined ? {} : { modelAlias: options.modelAlias }),
      });
      session = created.session;
      return session;
    },
    setMode: async (mode) => {
      session = await runtime().setPermissionMode(current().id, mode);
      return session;
    },
    models: async () => {
      const gateway = createGatewayClient({ socketPath: paths.sockets.gateway });
      try {
        return await gateway.models();
      } finally {
        await gateway.close();
      }
    },
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
        restoreConnection: restoreDaemon(ports, paths),
        onEvent: handlers.onEvent,
        onChildEvent: handlers.onChildEvent,
        onReconnecting: handlers.onReconnecting,
        signal: closing.signal,
      }),
    cancel: async (runId) => {
      await runtime().cancel(runId);
    },
    resolveApproval: async (approvalId, optionId) => {
      await runtime().resolveApproval(approvalId, optionId);
    },
    resolveElicitation: async (inputId, responses) => {
      await runtime().resolveElicitation(inputId, responses);
    },
    openUrl: (url) => ports.openUrl(url, closing.signal),
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
    model: async () => {
      const gateway = createGatewayClient({ socketPath: paths.sockets.gateway });
      try {
        return await gateway.modelOf(current().modelAlias);
      } finally {
        await gateway.close();
      }
    },
    startupNotices: async () => (await Promise.all(noticeSources.map((source) => source({ runtime: runtime(), session: current() })))).flat(),
    readImage: (file) => readImageAttachment(ports.files, ports.cwd, file),
    loadHistory: () => history.load(),
    recordHistory: (text) => history.append(text),
    close: async () => {
      closing.abort();
      await client?.close();
    },
  };
};
