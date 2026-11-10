import { INBOX_FULL_CODE, INBOX_MAX_PENDING, applyCapabilityOverride, inboxFullMessage } from '@momonga/protocol';
import type { InboxRowView } from '@momonga/protocol';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { Capabilities, CapabilityOverride, ToolCallingState, ElicitationAnswerRecord, GoverningFactView, ImageAttachment, MemoryView, PermissionMode, RunStatus, SkillView } from '@momonga/protocol';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import type { RunView, SessionView, TrustView } from '../src/client/views.ts';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { isTerminalStatus } from '../src/run/follow.ts';
import { continuedSession, resolveSession } from '../src/run/resolve-session.ts';
import type { FollowHandlers, StartRunOptions, TuiBackend } from '../src/tui/backend.ts';

export const SESSION: SessionView = {
  id: 'session-1',
  cwd: '/work/project',
  permissionMode: 'manual',
  modelAlias: 'default',
  bypassAllowed: false,
  createdAt: 1,
  envKeys: [],
  activeRunId: null,
  latestRunId: null,
  additionalDirectories: [],
  lastEventId: 0,
};

export const runView = (overrides: Partial<RunView> = {}): RunView => ({
  id: 'run-1',
  sessionId: SESSION.id,
  ordinal: 1,
  status: 'COMPLETED',
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  step: 1,
  limits: {},
  createdAt: 1,
  deadlineAt: 2,
  cancelRequested: false,
  lastSeq: 1,
  previousRunId: null,
  parentRunId: null,
  parentCallId: null,
  origin: 'trusted',
  history: 'inherit',
  ...overrides,
});

export type FakeConversationRun = { id: string; status?: RunStatus; frames: readonly RunEventFrame[] };

export type FakeConversation = { session: Partial<SessionView> & { id: string }; firstPrompt: string; runs: readonly FakeConversationRun[] };

export type FakeBackend = TuiBackend & {
  readonly opened: { modelAlias: string | undefined; permissionMode: PermissionMode | undefined }[];
  readonly calls: string[];
  called(call: string): Promise<void>;
  readonly started: { text: string; history: 'inherit' | 'fresh'; options?: StartRunOptions }[];
  readonly elicitationAnswers: { inputId: string; responses: Readonly<Record<string, ElicitationAnswerRecord>> }[];
  readonly openedUrls: string[];
  readonly openUrlCalls: { url: URL; watch: AbortSignal | undefined; onFailure(message: string): void }[];
  readonly recorded: string[];
  emit(frame: RunEventFrame): void;
  following(): FollowHandlers;
  finish(run: RunView): void;
  readonly inboxRows: InboxRowView[];
  deliverInbox(id: string): void;
  succeed(runId: string, next: RunView): void;
};

export type FakeBackendOptions = {
  trust?: TrustView;
  session?: Partial<SessionView>;
  contextWindow?: number;
  imageInput?: boolean;
  history?: readonly string[];
  skills?: readonly SkillView[];
  skillWarnings?: readonly string[];
  memories?: readonly MemoryView[];
  rules?: readonly GoverningFactView[];
  openUrlFailure?: Error;
  images?: Readonly<Record<string, ImageAttachment>>;
  targets?: readonly string[];
  startupNotices?: readonly string[];
  autoModeAvailable?: boolean;
  modelPending?: Promise<void>;
  aliases?: readonly string[];
  windows?: Readonly<Record<string, number>>;
  toolCalling?: Readonly<Record<string, ToolCallingState>>;
  conversations?: readonly FakeConversation[];
};

export const capabilitiesOf = (overrides: CapabilityOverride = {}): Capabilities =>
  applyCapabilityOverride(
    {
      contextWindow: 8192,
      maxOutputTokens: 2048,
      toolCalling: 'native',
      structuredOutput: 'none',
      streaming: true,
      stopSequences: true,
      imageInput: false,
      parallelToolCalls: false,
      schemaDialect: 'json-schema-2020-12',
      tokenCounting: 'estimated',
      usageReported: true,
      maxConcurrency: 1,
      source: 'declared',
    },
    overrides,
  );

const noPlanRoute = (route: string) => async (): Promise<never> => {
  throw new Error(`the fake backend serves no plan route ${route}`);
};

const NO_PLAN: PlanGatewayClient = {
  accounts: async () => ({ profiles: [], accounts: [] }),
  signInBegin: noPlanRoute('sign-in/begin'),
  signInComplete: noPlanRoute('sign-in/complete'),
  signInCancel: noPlanRoute('sign-in/cancel'),
  signOut: noPlanRoute('sign-out'),
  setActive: noPlanRoute('accounts/active'),
  resume: noPlanRoute('accounts/resume'),
  resetHost: noPlanRoute('host/reset'),
  accountModels: noPlanRoute('accounts/models'),
  addTarget: noPlanRoute('accounts/targets'),
};

export const fakeBackend = (options: FakeBackendOptions = {}): FakeBackend => {
  const calls: string[] = [];
  const started: { text: string; history: 'inherit' | 'fresh'; options?: StartRunOptions }[] = [];
  const elicitationAnswers: FakeBackend['elicitationAnswers'] = [];
  const openedUrls: string[] = [];
  const openUrlCalls: FakeBackend['openUrlCalls'] = [];
  let memories: MemoryView[] = [...(options.memories ?? [])];
  let rules: GoverningFactView[] = [...(options.rules ?? [])];
  const recorded: string[] = [];
  let handlers: FollowHandlers | undefined;
  let finishRun: ((run: RunView) => void) | undefined;
  let session: SessionView = { ...SESSION, ...options.session };
  const opened: FakeBackend['opened'] = [];
  let startedHere = false;
  const conversations: FakeConversation[] = [...(options.conversations ?? [])];
  const viewOf = (conversation: FakeConversation): SessionView => {
    const newest = conversation.runs.at(-1);
    const active = conversation.runs.find((run) => !isTerminalStatus(run.status ?? 'COMPLETED'));
    return { ...SESSION, cwd: session.cwd, ...conversation.session, latestRunId: newest === undefined ? null : newest.id, activeRunId: active === undefined ? null : active.id };
  };
  const stored = { listSessions: async (cwd?: string) => conversations.map(viewOf).filter((view) => cwd === undefined || view.cwd === cwd) };
  const conversationRun = (runId: string): { run: FakeConversationRun; view: RunView } | undefined => {
    for (const conversation of conversations) {
      const index = conversation.runs.findIndex((run) => run.id === runId);
      const run = conversation.runs[index];
      if (run !== undefined) return { run, view: runView({ id: run.id, sessionId: conversation.session.id, ordinal: index + 1, status: run.status ?? 'COMPLETED', lastSeq: run.frames.length }) };
    }
    return undefined;
  };
  const adopt = (view: SessionView): SessionView => {
    session = view;
    return session;
  };

  const toolCallingOf = (alias: string): { toolCalling?: ToolCallingState } => {
    const toolCalling = options.toolCalling?.[alias];
    return toolCalling === undefined ? {} : { toolCalling };
  };
  const aliasCapabilities = (alias: string): Capabilities => ({ ...capabilitiesOf({ contextWindow: options.windows?.[alias] ?? options.contextWindow ?? 8192 }), ...toolCallingOf(alias) });

  const waiters: { call: string; resolve: () => void }[] = [];

  const inboxRows: InboxRowView[] = [];
  const successors = new Map<string, RunView>();
  const pendingInbox = (): InboxRowView[] => inboxRows.filter((row) => row.state === 'pending');
  const settleInbox = (id: string, state: 'delivered' | 'withdrawn'): InboxRowView => {
    const index = inboxRows.findIndex((row) => row.id === id);
    const found = inboxRows[index];
    if (found === undefined) throw new Error(`no inbox row ${id}`);
    const settled: InboxRowView = found.state === 'pending' ? { ...found, state, settledAt: 2 } : found;
    inboxRows[index] = settled;
    return settled;
  };

  const record = (call: string): void => {
    calls.push(call);
    for (const waiter of waiters.filter((candidate) => candidate.call === call)) waiter.resolve();
  };

  const emit = (frame: RunEventFrame): void => {
    if (handlers === undefined) throw new Error('no run is being followed');
    handlers.onEvent(frame);
  };

  return {
    cwd: session.cwd,
    calls,
    opened,
    started,
    elicitationAnswers,
    openedUrls,
    openUrlCalls,
    recorded,
    called: (call) =>
      new Promise<void>((resolve) => {
        if (calls.includes(call)) resolve();
        else waiters.push({ call, resolve });
      }),
    emit,
    following: () => {
      if (handlers === undefined) throw new Error('no run is being followed');
      return handlers;
    },
    finish: (run) => {
      if (finishRun === undefined) throw new Error('no run is being followed');
      finishRun(run);
    },
    boot: async () => {
      record('boot');
      return options.trust ?? { path: session.cwd, decision: 'trusted' };
    },
    decideTrust: async (decision) => {
      record(`trust:${decision}`);
    },
    openSession: async (modelAlias, permissionMode) => {
      record('openSession');
      opened.push({ modelAlias, permissionMode });
      if (opened.length === 1) return session;
      return adopt({ ...session, id: `session-${opened.length}`, latestRunId: null, activeRunId: null, ...(modelAlias === undefined ? {} : { modelAlias }), ...(permissionMode === undefined ? {} : { permissionMode }) });
    },
    resumeSession: async (id) => {
      record(`resume:${id}`);
      return adopt(await resolveSession(stored, session.cwd, id));
    },
    continueSession: async () => {
      record('continue');
      return adopt(await continuedSession(stored, session.cwd));
    },
    sessions: async () =>
      conversations
        .filter((conversation) => conversation.session.id !== session.id && conversation.runs.length > 0 && viewOf(conversation).cwd === session.cwd)
        .map((conversation) => ({ id: conversation.session.id, createdAt: viewOf(conversation).createdAt, runs: conversation.runs.length, firstPrompt: conversation.firstPrompt }))
        .sort((left, right) => right.createdAt - left.createdAt),
    runs: async () => (conversations.find((conversation) => conversation.session.id === session.id)?.runs ?? []).flatMap((run) => conversationRun(run.id)?.view ?? []),
    autoModeAvailable: async () => options.autoModeAvailable ?? false,
    models: async () =>
      (options.aliases ?? [session.modelAlias]).map((id) => ({
        id,
        object: 'model',
        targets: [...(options.targets ?? ['primary'])],
        capabilities: aliasCapabilities(id),
        targetCapabilities: Object.fromEntries((options.targets ?? ['primary']).map((target) => [target, aliasCapabilities(id)])),
        targetCounters: Object.fromEntries((options.targets ?? ['primary']).map((target) => [target, `counter of ${target}`])),
      })),
    setModel: async (modelAlias: string) => {
      record(`model:${modelAlias}`);
      session = { ...session, modelAlias };
      return session;
    },
    setMode: async (mode: PermissionMode) => {
      record(`mode:${mode}`);
      session = { ...session, permissionMode: mode };
      return session;
    },
    startRun: async (text, history, runOptions = {}) => {
      startedHere = true;
      started.push({ text, history, ...(Object.keys(runOptions).length === 0 ? {} : { options: runOptions }) });
      if (!conversations.some((conversation) => conversation.session.id === session.id)) conversations.push({ session: { ...session }, firstPrompt: text, runs: [{ id: 'run-1', frames: [] }] });
      return runView({ status: 'QUEUED', sessionId: session.id });
    },
    follow: (runId, followHandlers) => {
      const kept = startedHere ? undefined : conversationRun(runId);
      startedHere = false;
      if (kept !== undefined) for (const frame of kept.run.frames) followHandlers.onEvent(frame);
      if (kept !== undefined && isTerminalStatus(kept.view.status)) return Promise.resolve(kept.view);
      return new Promise<RunView>((resolve) => {
        handlers = followHandlers;
        finishRun = resolve;
      });
    },
    inboxRows,
    deliverInbox: (id) => void settleInbox(id, 'delivered'),
    succeed: (runId, next) => void successors.set(runId, next),
    inbox: {
      add: async (delivery, text, images = []) => {
        record(`inbox:${delivery}:${text}`);
        if (pendingInbox().length >= INBOX_MAX_PENDING) throw Object.assign(new Error(inboxFullMessage()), { code: INBOX_FULL_CODE });
        const row: InboxRowView = {
          id: `row-${inboxRows.length + 1}`,
          sessionId: session.id,
          delivery,
          text,
          ...(images.length === 0 ? {} : { images: images.map((image) => ({ mediaType: image.mediaType, byteLength: image.data.length })) }),
          seq: inboxRows.length + 1,
          state: 'pending',
          createdAt: 1,
          settledAt: null,
        };
        inboxRows.push(row);
        return { row, pending: pendingInbox() };
      },
      withdraw: async (id) => {
        record(`inbox-withdraw:${id}`);
        const row = settleInbox(id, 'withdrawn');
        return { outcome: row.state === 'delivered' ? 'already_delivered' : 'withdrawn', row, pending: pendingInbox() };
      },
      list: async () => pendingInbox(),
      successor: async (runId) => successors.get(runId),
    },
    cancel: async (runId) => {
      record(`cancel:${runId}`);
    },
    resolveApproval: async (approvalId, optionId) => {
      record(`approve:${approvalId}:${optionId}`);
    },
    resolveElicitation: async (inputId, responses) => {
      record(`elicit:${inputId}`);
      elicitationAnswers.push({ inputId, responses });
    },
    openUrl: (url, watch, onFailure) => {
      openedUrls.push(url.href);
      openUrlCalls.push({ url, watch, onFailure });
      const failure = options.openUrlFailure;
      if (failure !== undefined) queueMicrotask(() => onFailure(failure.message));
      return Promise.resolve();
    },
    copyToClipboard: async (text) => {
      record(`copy:${text}`);
      return { kind: 'copied', characters: [...text].length };
    },
    skills: async () => ({ skills: [...(options.skills ?? [])], warnings: [...(options.skillWarnings ?? [])] }),
    memories: async () => memories,
    memory: async (id) => {
      const found = memories.find((memory) => memory.id === id);
      if (found === undefined) throw new Error(`memory ${id} does not exist`);
      return found;
    },
    deleteMemory: async (id) => {
      record(`memory-delete:${id}`);
      memories = memories.filter((memory) => memory.id !== id);
    },
    memoryHistory: async (id) => {
      record(`memory-history:${id}`);
      return memories.filter((memory) => memory.id === id);
    },
    rules: async () => rules,
    addRule: async (request) => {
      record(`rule-add:${request.target}`);
      const fact: GoverningFactView = {
        id: `rule-${rules.length + 1}`,
        kind: request.kind,
        target: request.target,
        text: request.text,
        scope: request.scope,
        validFrom: 0,
        validUntil: request.validUntil ?? null,
        retiredAt: null,
        supersedes: request.supersedes ?? [],
        enforcement: request.enforcement ?? null,
        source: { kind: 'command', at: 0 },
      };
      rules = [...rules, fact];
      return { fact, size: [], warnings: [] };
    },
    retireRule: async (id) => {
      record(`rule-retire:${id}`);
      const found = rules.find((fact) => fact.id === id);
      if (found === undefined) throw new Error(`rule ${id} does not exist`);
      const retired = { ...found, retiredAt: 1 };
      rules = rules.map((fact) => (fact.id === id ? retired : fact));
      return retired;
    },
    ignoreMarker: async (name) => {
      record(`marker-ignore:${name}`);
    },
    ruleHistory: async (id) => rules.filter((fact) => fact.id === id),
    model: async () => {
      if (options.modelPending !== undefined) await options.modelPending;
      const capabilities = { ...capabilitiesOf({ contextWindow: options.windows?.[session.modelAlias] ?? options.contextWindow ?? 8192, ...(options.imageInput === true ? { imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } } : {}) }), ...toolCallingOf(session.modelAlias) };
      const targets = [...(options.targets ?? ['primary'])];
      return {
        id: session.modelAlias,
        object: 'model',
        targets,
        capabilities,
        targetCapabilities: Object.fromEntries(targets.map((target) => [target, capabilities])),
        targetCounters: Object.fromEntries(targets.map((target) => [target, `counter of ${target}`])),
      };
    },
    startupNotices: async () => [...(options.startupNotices ?? []), ...(options.skillWarnings ?? [])],
    readImage: async (file) => {
      const image = options.images?.[file];
      if (image === undefined) throw new Error(`no such image ${file}`);
      return image;
    },
    loadHistory: async () => options.history ?? [],
    recordHistory: async (text) => {
      recorded.push(text);
    },
    plan: NO_PLAN,
    health: async () => ({
      ok: true,
      targets: Object.fromEntries((options.targets ?? ['primary']).map((target) => [target, { ok: true, breaker: 'closed' as const }])),
      version: '0.0.0',
      apiVersion: 1,
      pid: 1,
      startedAt: '2026-11-10T00:00:00.000Z',
      state: 'running',
    }),
    sandbox: async () => 'seatbelt',
    startSignInListener: async () => {
      throw new Error('the fake backend opens no sign-in listener');
    },
    signInTimers: createFakeTimers(createFakeClock(0)),
    detectLocalServers: async () => [],
    addModelConnection: async () => {
      throw new Error('the fake backend writes no model connection');
    },
    dismissedNotices: async () => ({}),
    dismissNotice: async () => undefined,
    close: async () => {
      record('close');
    },
  };
};
