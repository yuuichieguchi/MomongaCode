import type { Capabilities, ElicitationAnswerRecord, ImageAttachment, MemoryView, PermissionMode, SkillView } from '@momonga/protocol';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import type { RunView, SessionView, TrustView } from '../src/client/views.ts';
import type { FollowHandlers, StartRunOptions, TuiBackend } from '../src/tui/backend.ts';

export const SESSION: SessionView = {
  id: 'session-1',
  cwd: '/work/project',
  permissionMode: 'default',
  modelAlias: 'default',
  bypassAllowed: false,
  createdAt: 1,
  envKeys: [],
  activeRunId: null,
  latestRunId: null,
  additionalDirectories: [],
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
  history: 'inherit',
  ...overrides,
});

export type FakeBackend = TuiBackend & {
  readonly calls: string[];
  called(call: string): Promise<void>;
  readonly started: { text: string; history: 'inherit' | 'fresh'; options?: StartRunOptions }[];
  readonly elicitationAnswers: { inputId: string; responses: Readonly<Record<string, ElicitationAnswerRecord>> }[];
  readonly openedUrls: string[];
  readonly recorded: string[];
  emit(frame: RunEventFrame): void;
  finish(run: RunView): void;
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
  openUrlFailure?: Error;
  images?: Readonly<Record<string, ImageAttachment>>;
  targets?: readonly string[];
  startupNotices?: readonly string[];
  modelPending?: Promise<void>;
};

export const capabilitiesOf = (overrides: Partial<Capabilities> = {}): Capabilities => ({
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
  ...overrides,
});

export const fakeBackend = (options: FakeBackendOptions = {}): FakeBackend => {
  const calls: string[] = [];
  const started: { text: string; history: 'inherit' | 'fresh'; options?: StartRunOptions }[] = [];
  const elicitationAnswers: FakeBackend['elicitationAnswers'] = [];
  const openedUrls: string[] = [];
  let memories: MemoryView[] = [...(options.memories ?? [])];
  const recorded: string[] = [];
  let handlers: FollowHandlers | undefined;
  let finishRun: ((run: RunView) => void) | undefined;
  let session: SessionView = { ...SESSION, ...options.session };

  const waiters: { call: string; resolve: () => void }[] = [];

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
    started,
    elicitationAnswers,
    openedUrls,
    recorded,
    called: (call) =>
      new Promise<void>((resolve) => {
        if (calls.includes(call)) resolve();
        else waiters.push({ call, resolve });
      }),
    emit,
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
    openSession: async () => {
      record('openSession');
      return session;
    },
    setMode: async (mode: PermissionMode) => {
      record(`mode:${mode}`);
      session = { ...session, permissionMode: mode };
      return session;
    },
    startRun: async (text, history, runOptions = {}) => {
      started.push({ text, history, ...(Object.keys(runOptions).length === 0 ? {} : { options: runOptions }) });
      return runView({ status: 'QUEUED' });
    },
    follow: (_runId, followHandlers) =>
      new Promise<RunView>((resolve) => {
        handlers = followHandlers;
        finishRun = resolve;
      }),
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
    openUrl: async (url) => {
      if (options.openUrlFailure !== undefined) throw options.openUrlFailure;
      openedUrls.push(url.href);
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
    model: async () => {
      if (options.modelPending !== undefined) await options.modelPending;
      return { id: session.modelAlias, object: 'model', targets: [...(options.targets ?? ['primary'])], capabilities: capabilitiesOf({ contextWindow: options.contextWindow ?? 8192, imageInput: options.imageInput ?? false }) };
    },
    startupNotices: async () => [...(options.startupNotices ?? [])],
    readImage: async (file) => {
      const image = options.images?.[file];
      if (image === undefined) throw new Error(`no such image ${file}`);
      return image;
    },
    loadHistory: async () => options.history ?? [],
    recordHistory: async (text) => {
      recorded.push(text);
    },
    close: async () => {
      record('close');
    },
  };
};
