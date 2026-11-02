import type { PermissionMode } from '@momonga/protocol';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import type { RunView, SessionView, TrustView } from '../src/client/views.ts';
import type { FollowHandlers, TuiBackend } from '../src/tui/backend.ts';

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
  createdAt: 1,
  deadlineAt: 2,
  cancelRequested: false,
  lastSeq: 1,
  previousRunId: null,
  history: 'inherit',
  ...overrides,
});

export type FakeBackend = TuiBackend & {
  readonly calls: string[];
  called(call: string): Promise<void>;
  readonly started: { text: string; history: 'inherit' | 'fresh' }[];
  emit(frame: RunEventFrame): void;
  finish(run: RunView): void;
};

export type FakeBackendOptions = { trust?: TrustView; session?: Partial<SessionView>; contextWindow?: number };

export const fakeBackend = (options: FakeBackendOptions = {}): FakeBackend => {
  const calls: string[] = [];
  const started: { text: string; history: 'inherit' | 'fresh' }[] = [];
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
    startRun: async (text, history) => {
      started.push({ text, history });
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
    contextWindow: async () => options.contextWindow ?? 8192,
    close: async () => {
      record('close');
    },
  };
};
