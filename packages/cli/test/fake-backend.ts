import fs from 'node:fs';
import { INBOX_FULL_CODE, INBOX_MAX_PENDING, inboxFullMessage, parseCanon, imageCapability } from '@momonga/protocol';
import { SCRIPTED_MODEL, SCRIPTED_PROVIDER, createFakeClock, createFakeTimers, testKernelLock } from '@momonga/testkit';
import type { Capabilities, CapabilityOverride, LocalServerDetection, MomongaModelEntry, ToolCallingState, ElicitationAnswerRecord, GoverningFactView, ImageAttachment, MemoryJudgementView, MemoryView, PermissionMode, SkillView, InboxRowView, RunStatus } from '@momonga/protocol';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import type { RunView, SessionView, TrustView } from '../src/client/views.ts';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { isTerminalStatus } from '../src/run/follow.ts';
import { continuedSession, resolveSession } from '../src/run/resolve-session.ts';
import type { FollowHandlers, StartRunOptions, TuiBackend, UserInputBackend } from '../src/tui/backend.ts';
import type { ClipboardContent } from '../src/tui/screen/clipboard.ts';
import type { ReasoningCapability, ReasoningEffort, UserShellRecord } from '@momonga/protocol';
import { editProjectMandate, writeProjectMcpServer, editSettings, loadUserSettings, projectMandateState, readSettingsSnapshot, settingsWriterPorts } from '@momonga/config';
import type { CheckProposal } from '@momonga/runtime';
import type { TrustItemsView } from '@momonga/protocol';
import { hostPaths, momongaLayout, nodeFileSystem, systemTiming } from '@momonga/foundation';
import { fileLinkRootsOf, openFileLink, resolveFileLinks } from '../src/tui/screen/file-links.ts';
import type { FileLinkPorts } from '../src/tui/screen/file-links.ts';
import type { DetectRequest } from '../src/commands/models.ts';
import { freshHome } from './fresh-home.ts';
import { listingOf } from './models-shell-harness.ts';
import { PROBING_PLAN } from './fake-models-listing.ts';
import type { AgentView, McpServerView } from '@momonga/protocol';
import { createFromTemplate } from '../src/tui/file-templates.ts';
import { pendingProjectServerOf } from '../src/tui/project-items.ts';
import type { NetworkCheck, NetworkView } from '../src/tui/commands/network.ts';
import type { TemplateFiles } from '../src/tui/file-templates.ts';

const templateFiles: TemplateFiles = {
  readTextIfPresent: async (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
  mkdirPrivate: async (directory) => void fs.mkdirSync(directory, { recursive: true, mode: 0o700 }),
  writeText: async (file, text) => fs.writeFileSync(file, text, { mode: 0o600 }),
};

export const SESSION: SessionView = {
  id: 'session-1',
  cwd: '/work/project',
  permissionMode: 'manual',
  model: SCRIPTED_MODEL,
  bypassAllowed: false,
  createdAt: 1,
  envKeys: [],
  activeRunId: null,
  activeRunAt: null,
  latestRunId: null,
  latestRunAt: null,
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

export const FAKE_ANSWER_MS = 5;


export type FakeBackend = TuiBackend & {
  readonly opened: { model: string | undefined; permissionMode: PermissionMode | undefined; effort?: ReasoningEffort }[];
  readonly detections: DetectRequest[];
  readonly secrets: Map<string, string>;
  readonly listings: number[];
  modelsFile(): string;
  readonly calls: string[];
  called(call: string): Promise<void>;
  readonly started: { text: string; options?: StartRunOptions }[];
  readonly followed: string[];
  readonly elicitationAnswers: { inputId: string; responses: Readonly<Record<string, ElicitationAnswerRecord>> }[];
  readonly openedUrls: string[];
  readonly openUrlCalls: { url: URL; watch: AbortSignal; onFailure(message: string): void; kind?: 'web' | 'file' }[];
  readonly recorded: string[];
  emit(frame: RunEventFrame): void;
  following(): FollowHandlers;
  finish(run: RunView): void;
  readonly inboxRows: InboxRowView[];
  deliverInbox(id: string): void;
  addFromAnotherClient(text: string): void;
  readonly inboxFollowers: { sessionId: string; after: number }[];
  succeed(runId: string, next: RunView): void;
  readonly judgements: Map<string, MemoryJudgementView>;
  connectSessionStream(): void;
  judgeMemory(memoryId: string): void;
};

export type SessionStreamHandlers = { changed(): void; opened(): void; memoryJudged(memoryId: string): void };

export type FakeBackendOptions = {
  answerTimers?: { setTimeout(run: () => void, ms: number): unknown };
  storedResults?: Readonly<Record<string, string>>;
  agents?: readonly AgentView[];
  network?: NetworkView;
  networkCheck?: NetworkCheck;
  trust?: TrustView;
  trustItems?: TrustItemsView;
  checkProposal?: CheckProposal;
  session?: Partial<SessionView>;
  contextWindow?: number;
  imageInput?: boolean;
  history?: readonly string[];
  skills?: readonly SkillView[];
  skillWarnings?: readonly string[];
  memories?: readonly MemoryView[];
  rules?: readonly GoverningFactView[];
  openUrlFailure?: Error;
  fileLinksIn?: { home: string };
  images?: Readonly<Record<string, ImageAttachment>>;
  chain?: readonly string[];
  detected?: readonly LocalServerDetection[];
  detect?: (request: DetectRequest) => Promise<readonly LocalServerDetection[]>;
  programModel?: string;
  startupNotices?: readonly string[];
  autoModeAvailable?: boolean;
  modelPending?: Promise<void>;
  modelFailure?: Error;
  modelOfFailures?: Readonly<Record<string, Error>>;
  setModelFailure?: Error;
  modelsLockFailure?: Error;
  openSessionFailure?: Error;
  sessionModelFailures?: Readonly<Record<string, Error>>;
  models?: readonly string[];
  windows?: Readonly<Record<string, number>>;
  toolCalling?: Readonly<Record<string, ToolCallingState>>;
  reasoning?: Readonly<Record<string, ReasoningCapability>>;
  listedProbing?: boolean;
  probing?: readonly string[];
  chains?: Readonly<Record<string, readonly string[]>>;
  conversations?: readonly FakeConversation[];
  settingsPlace?: { home: string; projectDir: string };
  files?: readonly string[];
  clipboard?: ClipboardContent;
  shell?: UserInputBackend['shell'];
  pendingShell?: readonly UserShellRecord[];
  mcpServers?: readonly McpServerView[];
  memoryJudgements?: readonly MemoryJudgementView[];
  owedReadFailure?: Error;
  owedReadHeld?: Promise<void>;
  markShownFailure?: Error;
  markShownHeld?: Promise<void>;
  sessionStreamHeld?: boolean;
};

const OLLAMA_DEFAULT_TAG = 'latest';

const SERVER_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'apple']);

const serverKindOf = (provider: string): string => provider.split('-')[0] ?? provider;

export const listedEntryOf = (id: string, capabilities: MomongaModelEntry['chain'][number]['capabilities'], members: readonly string[] = [id]): MomongaModelEntry => {
  const parsed = parseCanon(id) ?? { provider: SCRIPTED_PROVIDER, ownName: id };
  return {
    id,
    object: 'model',
    provider: parsed.provider,
    ownName: parsed.ownName,
    ...(serverKindOf(parsed.provider) === 'ollama' ? { defaultTag: OLLAMA_DEFAULT_TAG } : {}),
    naming: SERVER_PROVIDERS.has(serverKindOf(parsed.provider)) ? 'server' : 'account',
    billing: 'local',
    capabilities,
    state: 'available',
    chain: members.map((member) => ({ model: member, counter: `counter of ${member}`, billing: 'local', adapter: 'chat-completions', answers: 'model', upstream: parseCanon(member)?.ownName ?? member, capabilities })),
  };
};

export const capabilitiesOf = ({ imageInput, imageTokens, ...overrides }: CapabilityOverride = {}): Capabilities =>
  ({ ...{
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
    }, ...overrides, ...imageCapability(imageInput ?? false, imageTokens) })

const noPlanRoute = (route: string) => async (): Promise<never> => {
  throw new Error(`the fake backend serves no plan route ${route}`);
};

const NO_PLAN: PlanGatewayClient = {
  accounts: async () => ({ profiles: [], accounts: [] }),
  signInBegin: noPlanRoute('sign-in/begin'),
  signInComplete: noPlanRoute('sign-in/complete'),
  signInCancel: noPlanRoute('sign-in/cancel'),
  signOut: noPlanRoute('sign-out'),
  rename: noPlanRoute('accounts/rename'),
  setActive: noPlanRoute('accounts/active'),
  resume: noPlanRoute('accounts/resume'),
  resetHost: noPlanRoute('host/reset'),
  accountModels: noPlanRoute('accounts/models'),
  addTarget: noPlanRoute('accounts/targets'),
};

export const PROMPT_SEQ = 0;

const promptFrame = (runId: string, sessionId: string, text: string): RunEventFrame => ({
  id: PROMPT_SEQ,
  event: 'user.message',
  data: { type: 'user.message', text, runId, sessionId, step: 0, createdAt: 1, id: PROMPT_SEQ, seq: PROMPT_SEQ },
});

export const FAKE_INIT_INSTRUCTION = 'Read this repository, then write AGENTS.md.';

export type FolderTrustFakeOptions = {
  settingsPlace: () => { home: string; projectDir: string };
  trust: TrustView | undefined;
  trustItems: TrustItemsView | undefined;
  cwd: () => string;
  record: (call: string) => void;
};

export const folderTrustFakes = ({ settingsPlace, trust, trustItems, cwd, record }: FolderTrustFakeOptions): Pick<TuiBackend, 'decideTrust' | 'trust' | 'clearTrust' | 'trustItems' | 'approveProjectItems' | 'projectMandate' | 'writeProjectMandate' | 'writeProjectMcpServer'> => {
  let trustNow: TrustView | undefined;
  return {
    decideTrust: async (decision) => {
      record(`trust:${decision}`);
      trustNow = { path: cwd(), decision };
    },
    trust: async () => trustNow ?? trust ?? { path: cwd(), decision: 'trusted' },
    clearTrust: async () => {
      record('trust:clear');
      trustNow = { path: cwd(), decision: null };
    },
    trustItems: async (server) => {
      if (server !== undefined) record(`trustItems:${server}`);
      return trustItems ?? { items: [], refused: [] };
    },
    approveProjectItems: async (approval) => {
      record(`approve:${JSON.stringify(approval)}`);
    },
    projectMandate: async () => projectMandateState({ projectDir: settingsPlace().projectDir, approvals: (await loadUserSettings({ env: process.env, home: settingsPlace().home, signal: new AbortController().signal })).settings.projectApprovals, signal: new AbortController().signal }),
    writeProjectMandate: (document, signal) =>
      editProjectMandate(
        settingsPlace().projectDir,
        (current) => {
          for (const key of Object.keys(current)) delete current[key];
          Object.assign(current, document);
          return true;
        },
        { home: settingsPlace().home, trust: { isTrusted: () => (trust?.decision ?? 'trusted') === 'trusted' }, ...settingsWriterPorts(settingsPlace().home, { lock: testKernelLock(), signal }) },
      ),
    writeProjectMcpServer: (name, server, signal) =>
      writeProjectMcpServer(settingsPlace().projectDir, name, server, { env: process.env, home: settingsPlace().home, trust: { isTrusted: () => (trust?.decision ?? 'trusted') === 'trusted' }, ...settingsWriterPorts(settingsPlace().home, { lock: testKernelLock(), signal }) }),
  };
};

export const fakeBackend = (options: FakeBackendOptions = {}): FakeBackend => {
  const answerLater = (): Promise<void> => new Promise((resolve) => (options.answerTimers ?? systemTiming).setTimeout(resolve, FAKE_ANSWER_MS));
  const settingsPlace = (): { home: string; projectDir: string } => {
    if (options.settingsPlace === undefined) throw new Error('the fake backend was given no settings place');
    return options.settingsPlace;
  };
  const calls: string[] = [];
  const started: { text: string; options?: StartRunOptions }[] = [];
  const followed: string[] = [];
  const elicitationAnswers: FakeBackend['elicitationAnswers'] = [];
  const openedUrls: string[] = [];
  const openUrlCalls: FakeBackend['openUrlCalls'] = [];
  let memories: MemoryView[] = [...(options.memories ?? [])];
  let rules: GoverningFactView[] = [...(options.rules ?? [])];
  const recorded: string[] = [];
  let handlers: FollowHandlers | undefined;
  let finishRun: ((run: RunView) => void) | undefined;
  let session: SessionView = { ...SESSION, ...options.session };
  const fileLinkPortsOf = (signal: AbortSignal): FileLinkPorts => ({ paths: hostPaths(signal), files: nodeFileSystem });
  const openUrl = (url: URL, watch: AbortSignal, onFailure: (message: string) => void, kind?: 'web' | 'file'): void => {
    openedUrls.push(url.href);
    openUrlCalls.push({ url, watch, onFailure, ...(kind === undefined ? {} : { kind }) });
    const failure = options.openUrlFailure;
    if (failure !== undefined) queueMicrotask(() => onFailure(failure.message));
  };
  const opened: FakeBackend['opened'] = [];
  let startedHere = false;
  let startedPrompt: string | undefined;
  const conversations: FakeConversation[] = [...(options.conversations ?? [])];
  const viewOf = (conversation: FakeConversation): SessionView => {
    const newest = conversation.runs.at(-1);
    const active = conversation.runs.find((run) => !isTerminalStatus(run.status ?? 'COMPLETED'));
    const view = { ...SESSION, cwd: session.cwd, ...conversation.session };
    return { ...view, latestRunId: newest === undefined ? null : newest.id, latestRunAt: newest === undefined ? null : view.createdAt, activeRunId: active === undefined ? null : active.id, activeRunAt: active === undefined ? null : view.createdAt };
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

  const toolCallingOf = (model: string): { toolCalling?: ToolCallingState } => {
    const toolCalling = options.toolCalling?.[model];
    return toolCalling === undefined ? {} : { toolCalling };
  };
  const reasoningOf = (model: string): { reasoning?: ReasoningCapability } => {
    const reasoning = options.reasoning?.[model];
    return reasoning === undefined ? {} : { reasoning };
  };
  const listedCapabilities = (model: string): Capabilities => ({ ...capabilitiesOf({ contextWindow: options.windows?.[model] ?? options.contextWindow ?? 8192 }), ...toolCallingOf(model), ...reasoningOf(model) });

  let modelsHome: string | undefined;
  const homeOfModels = (): string => {
    modelsHome ??= options.settingsPlace?.home ?? freshHome();
    return modelsHome;
  };
  const modelsFile = (): string => momongaLayout(homeOfModels(), process.platform, {}).settingsFile;
  const detections: DetectRequest[] = [];
  const secrets = new Map<string, string>();
  const listings: number[] = [];
  const writtenEntries = (): MomongaModelEntry[] => {
    const readHome = modelsHome ?? options.settingsPlace?.home;
    return readHome !== undefined && fs.existsSync(momongaLayout(readHome, process.platform, {}).settingsFile) ? listingOf(readHome).data : [];
  };
  const savedEffortOf = (id: string): { effort?: ReasoningEffort } => {
    const effort = writtenEntries().find((entry) => entry.id === id)?.effort;
    return effort === undefined ? {} : { effort };
  };
  let measured = false;
  void options.modelPending?.then(() => {
    measured = true;
  });
  const listedModels = async (): Promise<MomongaModelEntry[]> => {
    const written = writtenEntries();
    const scripted = (options.models ?? [session.model]).map((id) => ({ ...listedEntryOf(id, options.listedProbing === true || (options.probing?.includes(id) === true && !measured) ? PROBING_PLAN : listedCapabilities(id), options.chains?.[id] ?? options.chain ?? [id]), ...savedEffortOf(id) }));
    return [...scripted, ...written.filter((entry) => !scripted.some((other) => other.id === entry.id))];
  };

  const waiters: { call: string; resolve: () => void }[] = [];

  const inboxRows: InboxRowView[] = [];
  const inboxFollowers: { sessionId: string; after: number }[] = [];
  const inboxListeners = new Set<() => void>();
  const sessionStreams: { sessionId: string; handlers: SessionStreamHandlers | undefined }[] = [];
  const judgements = new Map<string, MemoryJudgementView>((options.memoryJudgements ?? []).map((judgement) => [judgement.memoryId, judgement]));
  const latestSessionStream = (): SessionStreamHandlers => {
    const handlers = sessionStreams.at(-1)?.handlers;
    if (handlers === undefined) throw new Error('the app follows no session stream with handlers for its connection and for memory.judged');
    return handlers;
  };
  const connectSessionStream = (): void => {
    const latest = sessionStreams.at(-1);
    const handlers = latestSessionStream();
    record(`session-stream-open:${latest?.sessionId ?? ''}`);
    handlers.opened();
  };
  const pendingRowOf = (delivery: InboxRowView['delivery'], text: string, images: readonly ImageAttachment[]): InboxRowView => ({
    id: `row-${inboxRows.length + 1}`,
    sessionId: session.id,
    delivery,
    text,
    ...(images.length === 0 ? {} : { images: images.map((image) => ({ mediaType: image.mediaType, byteLength: image.data.length })) }),
    seq: inboxRows.length + 1,
    state: 'pending',
    createdAt: 1,
    settledAt: null,
  });
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
    detections,
    secrets,
    listings,
    modelsFile,
    started,
    followed,
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
    ...folderTrustFakes({ settingsPlace, trust: options.trust, trustItems: options.trustItems, cwd: () => session.cwd, record }),
    checkProposal: async () => options.checkProposal ?? { ask: false },
    answerCheck: async (answer) => {
      record(`check:${JSON.stringify(answer)}`);
    },
    openSession: async (model, permissionMode, effort) => {
      record('openSession');
      opened.push({ model, permissionMode, ...(effort === undefined ? {} : { effort }) });
      await answerLater();
      if (options.openSessionFailure !== undefined) throw options.openSessionFailure;
      if (opened.length === 1) return model === undefined ? session : adopt({ ...session, model, ...(effort === undefined ? {} : { effort }) });
      return adopt({ ...session, id: `session-${opened.length}`, latestRunId: null, latestRunAt: null, activeRunId: null, activeRunAt: null, ...(model === undefined ? {} : { model }), ...(permissionMode === undefined ? {} : { permissionMode }), ...(effort === undefined ? {} : { effort }) });
    },
    resumeSession: async (id) => {
      record(`resume:${id}`);
      return adopt(await resolveSession(stored, session.cwd, id, process.platform));
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
    toolResult: async (runId, callId, offset) => {
      const text = options.storedResults?.[`${runId}/${callId}`];
      if (text === undefined) throw new Error(`the fake holds no stored result for ${runId}/${callId}`);
      return { text, offset, next: null, totalBytes: new TextEncoder().encode(text).length };
    },
    autoModeAvailable: async () => options.autoModeAvailable ?? false,
    models: async () => {
      await answerLater();
      return listedModels();
    },
    modelList: async () => {
      await answerLater();
      listings.push(listings.length);
      return { object: 'list', data: await listedModels(), start: null, roles: {} };
    },
    modelsHost: (signal) => ({
      home: homeOfModels(),
      settingsFile: modelsFile(),
      lock: options.modelsLockFailure === undefined ? testKernelLock : () => {
        throw options.modelsLockFailure;
      },
      platform: 'linux',
      interrupt: signal,
      files: {
        readText: (file) => fs.promises.readFile(file, 'utf8'),
        readTextIfPresent: async (file) => (fs.existsSync(file) ? fs.promises.readFile(file, 'utf8') : undefined),
      },
      listing: async () => ({ object: 'list', data: await listedModels(), start: null, roles: {} }),
      detect: async (request) => {
        detections.push(request);
        return options.detect === undefined ? [...(options.detected ?? [])] : options.detect(request);
      },
      describe: async (_server, model) => model,
      programModel: async () => {
        if (options.programModel === undefined) throw new Error('the fake backend starts no server program');
        return options.programModel;
      },
    }),
    storeSecret: async (name, value) => {
      record(`secret:${name}`);
      secrets.set(name, value);
    },
    setEffort: async (effort: ReasoningEffort | null) => {
      record(`effort:${effort ?? 'none chosen'}`);
      await answerLater();
      const { effort: _dropped, ...rest } = session;
      session = effort === null ? rest : { ...rest, effort };
      return session;
    },
    setModel: async (model: string, effort?: ReasoningEffort) => {
      record(effort === undefined ? `model:${model}` : `model:${model} effort:${effort}`);
      await answerLater();
      if (options.setModelFailure !== undefined) throw options.setModelFailure;
      const { effort: _dropped, ...rest } = session;
      session = model === session.model && effort === undefined ? { ...session } : { ...rest, model, ...(effort === undefined ? {} : { effort }) };
      return session;
    },
    setMode: async (mode: PermissionMode) => {
      record(`mode:${mode}`);
      session = { ...session, permissionMode: mode };
      return session;
    },
    startRun: async (text, runOptions = {}) => {
      startedHere = true;
      startedPrompt = text;
      started.push({ text, ...(Object.keys(runOptions).length === 0 ? {} : { options: runOptions }) });
      if (!conversations.some((conversation) => conversation.session.id === session.id)) conversations.push({ session: { ...session }, firstPrompt: text, runs: [{ id: 'run-1', frames: [] }] });
      return runView({ status: 'QUEUED', sessionId: session.id });
    },
    compact: async (instructions) => {
      startedHere = true;
      startedPrompt = instructions === undefined ? '/compact' : `/compact ${instructions}`;
      record(instructions === undefined ? 'compact' : `compact:${instructions}`);
      return runView({ status: 'QUEUED', sessionId: session.id });
    },
    follow: (runId, followHandlers) => {
      followed.push(runId);
      const kept = startedHere ? undefined : conversationRun(runId);
      startedHere = false;
      const prompt = startedPrompt;
      startedPrompt = undefined;
      if (prompt !== undefined) followHandlers.onEvent(promptFrame(runId, session.id, prompt));
      if (kept !== undefined) for (const frame of kept.run.frames) followHandlers.onEvent(frame);
      if (kept !== undefined && isTerminalStatus(kept.view.status)) return Promise.resolve(kept.view);
      return new Promise<RunView>((resolve) => {
        handlers = followHandlers;
        finishRun = resolve;
      });
    },
    inboxRows,
    deliverInbox: (id) => void settleInbox(id, 'delivered'),
    inboxFollowers,
    addFromAnotherClient: (text) => {
      inboxRows.push(pendingRowOf('queue', text, []));
      for (const listener of inboxListeners) listener();
    },
    succeed: (runId, next) => void successors.set(runId, next),
    judgements,
    connectSessionStream,
    judgeMemory: (memoryId) => latestSessionStream().memoryJudged(memoryId),
    memoryJudgement: async (memoryId: string) => {
      record(`memory-judgement:${memoryId}`);
      await answerLater();
      const found = judgements.get(memoryId);
      if (found === undefined) throw new Error(`memory ${memoryId} has no judgement`);
      return found;
    },
    memoryJudgements: async (project: string) => {
      record(`memory-judgements:${project}`);
      await answerLater();
      await options.owedReadHeld;
      if (options.owedReadFailure !== undefined) throw options.owedReadFailure;
      return [...judgements.values()].filter((judgement) => judgement.owed);
    },
    markMemoryJudgementsShown: async (memoryIds: readonly string[]) => {
      record(`memory-judgements-shown:${memoryIds.join(',')}`);
      await answerLater();
      await options.markShownHeld;
      if (options.markShownFailure !== undefined) throw options.markShownFailure;
    },
    userInput: {
      fileCandidates: async () => ({ entries: [...(options.files ?? [])], truncated: false }),
      shell: async (command, include, io) => {
        record(`shell:${include ? '!' : '!!'}:${command}`);
        if (options.shell !== undefined) return options.shell(command, include, io);
        io.onOutput(`out of ${command}\n`);
        return { kind: 'exit', record: { command, exitCode: 0, output: `out of ${command}`, include } };
      },
      stopShell: async () => {
        record('shell-stop');
      },
      pendingShell: async () => options.pendingShell ?? [],
      readClipboard: async () => {
        record('clipboard-read');
        return options.clipboard ?? { kind: 'empty' };
      },
    },
    inbox: {
      add: async (delivery, text, images = [], attachMentions = false) => {
        record(`inbox:${delivery}:${text}`);
        if (attachMentions) record(`inbox-mentions:${text}`);
        if (pendingInbox().length >= INBOX_MAX_PENDING) throw Object.assign(new Error(inboxFullMessage()), { code: INBOX_FULL_CODE });
        const row = pendingRowOf(delivery, text, images);
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
      follow: (sessionId: string, after: number, given: (() => void) | SessionStreamHandlers, signal: AbortSignal) => {
        inboxFollowers.push({ sessionId, after });
        const handlers = typeof given === 'function' ? undefined : given;
        const changed = typeof given === 'function' ? given : () => given.changed();
        const stream = { sessionId, handlers };
        sessionStreams.push(stream);
        inboxListeners.add(changed);
        if (handlers !== undefined && options.sessionStreamHeld !== true) queueMicrotask(() => {
          if (!signal.aborted) connectSessionStream();
        });
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            inboxListeners.delete(changed);
            stream.handlers = undefined;
            reject(signal.reason);
          });
        });
      },
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
    openUrl,
    openFile: (url, watch, onFailure) => {
      const place = options.fileLinksIn;
      if (place === undefined) throw new Error('this fake backend was not given a place for file links');
      const filePorts = fileLinkPortsOf(watch);
      openFileLink(url, () => fileLinkRootsOf({ cwd: session.cwd, home: place.home, additionalDirectories: session.additionalDirectories }, filePorts), filePorts, openUrl, watch, onFailure);
    },
    fileLinks: async (candidates, signal) => {
      const place = options.fileLinksIn;
      if (place === undefined) return new Map();
      const filePorts = fileLinkPortsOf(signal);
      return resolveFileLinks(candidates, await fileLinkRootsOf({ cwd: session.cwd, home: place.home, additionalDirectories: session.additionalDirectories }, filePorts), filePorts);
    },
    copyToClipboard: async (text) => {
      record(`copy:${text}`);
      return { kind: 'copied', characters: [...text].length };
    },
    skills: async () => ({ skills: [...(options.skills ?? [])], warnings: [...(options.skillWarnings ?? [])] }),
    agents: async () => ({ agents: [...(options.agents ?? [])], warnings: [] }),
    network: async () => {
      if (options.network === undefined) throw new Error('the fake backend was given no network view');
      return options.network;
    },
    checkNetwork: async () => {
      if (options.networkCheck === undefined) throw new Error('the fake backend was given no network check');
      return options.networkCheck;
    },
    createFromTemplate: (kind, name) => createFromTemplate(templateFiles, settingsPlace().home, kind, name),
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
      await answerLater();
      if (options.modelPending !== undefined) await options.modelPending;
      if (options.modelFailure !== undefined) throw options.modelFailure;
      const sessionFailure = options.sessionModelFailures?.[session.model];
      if (sessionFailure !== undefined) throw sessionFailure;
      const capabilities = { ...capabilitiesOf({ contextWindow: options.windows?.[session.model] ?? options.contextWindow ?? 8192, ...(options.imageInput === true ? { imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } } : {}) }), ...toolCallingOf(session.model), ...reasoningOf(session.model) };
      return { ...listedEntryOf(session.model, capabilities, options.chain ?? [session.model]), ...savedEffortOf(session.model) };
    },
    modelOf: async (model: string) => {
      await answerLater();
      if (options.modelPending !== undefined) await options.modelPending;
      const failure = options.modelOfFailures?.[model];
      if (failure !== undefined) throw failure;
      const entry = (await listedModels()).find((listed) => listed.id === model);
      if (entry === undefined) throw new Error(`the fake gateway does not list the model ${model}`);
      return entry;
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
      models: Object.fromEntries((options.chain ?? options.models ?? [session.model]).map((model) => [model, { ok: true, breaker: 'closed' as const }])),
      version: '0.0.0',
      apiVersion: 1,
      pid: 1,
      startedAt: '2026-11-10T00:00:00.000Z',
      state: 'running',
      activeRequests: 0,
    }),
    sandbox: async () => 'seatbelt',
    startSignInListener: async () => {
      throw new Error('the fake backend opens no sign-in listener');
    },
    signInTimers: createFakeTimers(createFakeClock(0)),
    dismissedNotices: async () => ({}),
    dismissNotice: async () => undefined,
    settings: async () => readSettingsSnapshot({ env: process.env, ...settingsPlace(), trusted: (options.trust?.decision ?? 'trusted') === 'trusted', signal: new AbortController().signal }),
    editSettings: (layer, operation, signal) => editSettings(settingsPlace(), layer, operation, { env: process.env, trusted: (options.trust?.decision ?? 'trusted') === 'trusted', lock: testKernelLock(), signal }),
    mcpServers: async () => {
      record('mcpServers');
      return options.mcpServers ?? [];
    },
    folderMcpServers: async () => {
      record('folderMcpServers');
      return options.mcpServers ?? [];
    },
    pendingProjectServer: (name) => pendingProjectServerOf({ ...settingsPlace(), trust: { isTrusted: async () => (options.trust?.decision ?? 'trusted') === 'trusted' }, signal: new AbortController().signal }, name),
    initInstruction: async () => FAKE_INIT_INSTRUCTION,
    close: async () => {
      record('close');
    },
  };
};
