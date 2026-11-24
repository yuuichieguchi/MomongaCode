import { askTrustItems } from './project-items.ts';
import { askProjectCheck } from './project-check.ts';
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Text, useApp, useStdout } from 'ink';
import { createKeyedSerializer } from '@momonga/foundation';
import { DEFAULT_PERMISSION_MODE, PLAN_NOT_ELIGIBLE_CODE, PLAN_USE_NOT_ENABLED_CODE, SIGN_IN_REQUIRED_CODE, USAGE_LIMIT_CODES, USAGE_PAUSED_CODE, agentReadiness, autoModeNotice, displayMapOf, escapeTerminalLine, isNotListedCapabilities, isOpaqueEvent, messageOf, PLAN_DISABLED_STATE } from '@momonga/protocol';
import type { OutputStyle, ReasoningEffort, ChainCapabilities, ImageAttachment, InboxDelivery, Measuring, InboxRowView, MemoryJudgementView, MomongaModelEntry, PermissionMode, PlanAccountRef, PlanAccountsResponse, PlanProfileView } from '@momonga/protocol';
import { listingViewsOf } from '../client/gateway-client.ts';
import type { RunView, SessionView } from '../client/views.ts';
import { describeAttachment, pastedImagePaths } from '../images.ts';
import { describeFailure } from '../failure.ts';
import { modelChosen } from './transcript.ts';
import { followMeasurement, modelUnreadText, readinessNoticeOf } from '../readiness.ts';
import { isPrompt } from '../run/prompt-event.ts';
import { isTerminalStatus } from '../run/follow.ts';
import { describeRunEnd, endReasonLines } from '../run/headless.ts';
import type { Reopen } from '../run/resolve-session.ts';
import { accountsOf, profileOf } from '../plan/accounts.ts';
import type { StartRunOptions, TuiBackend } from './backend.ts';
import { createBackgroundTasks } from './background-tasks.ts';
import type { BackgroundTasks } from './background-tasks.ts';
import { autoNoticeDue } from './notices.ts';
import { formatMemoryJudgement, memoryJudgementLevel } from '../memory/format.ts';
import type { AutoNoticePair } from './notices.ts';
import { DEFAULT_SLASH_COMMANDS, sessionSlashCommands } from './commands/index.ts';
import { createFoundServers } from './models/context.ts';
import { notConfiguredAnyMoreText } from './models/texts.ts';
import { createPlanFlows } from './plan-flows.ts';
import type { PlanFlows } from './plan-flows.ts';
import { bannerRows, figureDrawn } from './startup.tsx';
import { TailPoseContext, useTailWag } from './screen/tail-wag.ts';
import type { BannerModel, StartupBanner, StartupConfig } from './startup.tsx';
import { pickConversation } from './commands/resume.ts';
import { Abandoned, currentStep, isAbandoned, untilAborted } from './flow-step.ts';
import { skillCommands } from './commands/skills.ts';
import { createReplayQueue } from './replay.ts';
import type { ReplayQueue } from './replay.ts';
import { applyAction, emptyEditor, enterOf, expandedText, heldMessageOf, insertPaste, insertSpan, insertText, isEditorAction, placeCaret, placeMessages, placeText, pushHistory, withHistory } from './editor.ts';
import type { HeldMessage } from './editor.ts';
import { hasMentionToken, imageSpanLabel, NO_CLIPBOARD_PROGRAM_HINT, NO_IMAGE_INPUT_HINT, useAtMenu } from './attach.ts';
import type { AtAct } from './attach.ts';
import { leftShell, SHELL_MARK, shellCommandOf, shellEnded, shellFailed, shellHint, shellHistoryText, shellLabel, shellOutput, shellStarted, showShellRecord, typedIntoDraft } from './user-shell.ts';
import { INBOX_FULL_HINT, busyDeliveryOf, busyHint, completionHint, draftOf, isInboxFull, onFirstLine, waitingRows } from './busy-input.ts';
import type { EditorState } from './editor.ts';
import { editorUnsetHint } from './external-editor.ts';
import type { ExternalEditorPort } from './external-editor.ts';
import { fixedKeyBindings } from './keys/store.ts';
import type { KeyBindings } from './keys/store.ts';
import { chordPressOf, DEFAULT_KEY_TABLE, newlineKeyHint } from './keys/table.ts';
import type { ActionId, KeyContext, KeySpec, KeyTable } from './keys/table.ts';
import { a11yOf, applyA11y, NOTHING_ASKED, statusLine, statusLines } from './screen/a11y.ts';
import type { AskedA11y, StatusFacts, StoredA11y } from './screen/a11y.ts';
import { AtList, AttachmentLines, heldAttachments } from './screen/attachments.tsx';
import type { Attachment } from './screen/attachments.tsx';
import { contextPercentOf, Footer, newlineHintText, planRowFits } from './screen/footer.tsx';
import type { FooterModel } from './screen/footer.tsx';

const modelFactOf = (model: FooterModel | undefined): { model?: FooterModel } => (model === undefined ? {} : { model });
import { formatTokens } from '../format-tokens.ts';
import { HistoryView, useBackgroundAnswered } from './screen/history-view.tsx';
import type { ViewSource } from './screen/viewport.ts';
import { CHAT_MARK, InputBox, inputContentRows, inputOffsetAt, inputRowsOf, keptDraftLine } from './screen/input-box.tsx';
import { untilNextKey } from './screen/input.ts';
import type { ScreenTerminal } from './screen/input.ts';
import type { RowRequests } from './screen/layout.ts';
import { allocate, drawnTranscriptRows, inputTopOf, menuRowsCap, naturalRows, panelRowsCap, regionAt } from './screen/layout.ts';
import { chordContextsOf, keyRouteOf } from './screen/key-route.ts';
import { SELECT_CONTEXTS } from './select.tsx';
import type { KeyRoute, KeyRouteFacts } from './screen/key-route.ts';
import { InvitationLine, invitationKeyOf, invitationRows, isMenuAction, useSlashMenu } from './screen/menu.tsx';
import { Screen } from './screen/screen.tsx';
import { createTranscriptStore } from './screen/store.ts';
import type { TranscriptStore } from './screen/store.ts';
import { watchFileLinks } from './screen/file-link-watch.ts';
import { AgentList, agentListDrawn, agentListLines, agentListRequest, chosenIndexOf, viewTargetsOf } from './screen/subagents.tsx';
import type { ViewTarget } from './screen/subagents.tsx';
import { agentHeader, createAgentViews, endStateOf } from './screen/agent-views.ts';
import { declaredReasoning, effortChoiceText, effortInForce, effortLine, modelWithEffort, shownEffort } from './effort.ts';
import { SCROLLBAR_COLUMNS, TranscriptView } from './screen/transcript-view.tsx';
import { usePromptPointer, usePrompts } from './screen/use-prompts.tsx';
import { useToolView } from './screen/tool-view.ts';
import { useTranscriptView } from './screen/use-transcript-view.ts';
import type { ScreenTimers } from './screen/timers.ts';
import { DAEMON_STOPPING_TEXT, commandPhaseText, loadingText, WaitingRow, waitingOf } from './screen/waiting-row.tsx';
import type { Loading, WaitingPhase } from './screen/waiting-row.tsx';
import { createSlashRegistry, modeToastText, namesOf, parseSlash, NEEDS_SESSION_NOTE } from './slash.ts';
import type { AutoModePort, SelectedText, ShellPort, SlashCommand, SlashRegistry } from './slash.ts';
import { extractSelection } from './screen/selection.ts';
import { COPY_MAX_BYTES } from './screen/constants.ts';
import { clipboardReadMessage } from './screen/clipboard.ts';

const READING_CLIPBOARD = 'reading the clipboard';
import type { KeyEvent, MouseEvent, TerminalEvent } from './terminal/events.ts';
import type { ScreenMode } from './terminal/modes.ts';
import { NEWLINE_HINT } from './terminal/negotiation.ts';
import { UNSTORED_TUI_SETTINGS, useAttention } from './screen/notify.ts';
import type { AttentionTerminal, WaitingNotice } from './screen/notify.ts';
import { approvalHeading, approvalWording, elicitationHeading, trustHeading } from './screen/prompt-panel.tsx';
import type { NotifyMode, TuiSettingsPort } from './screen/notify.ts';
import { UNREPORTED_COLOUR_HOST, appearanceOf, applyAppearance, applyTheme } from './screen/theme.ts';
import type { ColourHost, ThemeId } from './screen/theme.ts';
import { appendEntry, BANNER_KEY, toolOf, foldChildEvent, foldLiveEvent, foldReplayedEvent, blockingPrompt, nextMode, promptTakesFocus, runCreated, runLeft, sessionTokens, setThoughtWindow, shownRunPhase, subagentEnded, subagentStarted, thoughtWindowOf } from './transcript.ts';
import type { Entry } from './transcript.ts';
import type { OwnGeneration } from '../handover/mover.ts';
import { attachmentDigest } from '../handover/record.ts';
import type { HandoverAttachment, HandoverInput, HandoverNote } from '../handover/record.ts';
import { attachmentChangedText, attachmentUnreadableText } from '../handover/texts.ts';
import { createNoteReplay, createOrigins, entryOfNote, isLocalNote, positionOf, restoreToggles, togglesOf, viewOf } from './handover.ts';
import type { LocalNote, NoteReplay, TuiAdoption, TuiMovePort, TuiSnapshot, TuiSurface } from './handover.ts';
import { createHistoryFeed } from './screen/history-feed.ts';
import { FOLLOWING } from './screen/viewport.ts';
import type { Position } from './screen/viewport.ts';

export type TuiOutcome = { error?: Error; reopen?: string };

export type AppProps = {
  backend: TuiBackend;
  terminal: ScreenTerminal;
  attentionTerminal?: AttentionTerminal;
  initialMode: PermissionMode | undefined;
  initialPrompt?: string;
  initialImages?: readonly string[];
  initialSkill?: string;
  reopen?: Reopen;
  startup?: StartupConfig;
  slash?: SlashRegistry;
  tasks?: BackgroundTasks;
  autoMode?: AutoModePort;
  shell?: ShellPort;
  keys?: KeyTable;
  keyBindings?: KeyBindings;
  a11y?: AskedA11y;
  externalEditor?: ExternalEditorPort;
  copyOnSelect?: boolean;
  colour?: ColourHost;
  tuiSettings?: TuiSettingsPort;
  keySettleMs?: number;
  move?: TuiMovePort;
  adoption?: TuiAdoption;
  now(): number;
  timers: ScreenTimers;
  onExit(outcome: TuiOutcome): void;
};

const UNKNOWN_ATTENTION_TERMINAL: AttentionTerminal = { osc9: false, tmux: false };

const unavailableAutoMode: AutoModePort = {
  check() {
    return Promise.reject(new Error('the auto-mode check is not available in this interface'));
  },
  status() {
    return Promise.reject(new Error('the auto-mode status is not available in this interface'));
  },
};

const unavailableShell: ShellPort = {
  run() {
    return Promise.reject(new Error('the shell commands are not available in this interface'));
  },
};

const EXTERNAL_EDITOR_UNAVAILABLE = 'the external editor is not available in this interface';

const unavailableExternalEditor: ExternalEditorPort = {
  edit() {
    return Promise.reject(new Error(EXTERNAL_EDITOR_UNAVAILABLE));
  },
  open() {
    return Promise.reject(new Error(EXTERNAL_EDITOR_UNAVAILABLE));
  },
};

export const STILL_STARTING_HINT = 'Still starting. Your text is kept.';
export const taskRunningHint = (keys: KeyTable): string => {
  const key = keys.keyHint('run.stop');
  return key === '' ? 'A run is working.' : `A run is working. ${key.charAt(0).toUpperCase()}${key.slice(1)} stops it.`;
};
export const EXIT_ARM_MS = 3000;
export const HISTORY_SEARCH_TITLE = 'History';

const isPlainKey = (event: KeyEvent, name: 'enter' | 'escape'): boolean => 'name' in event && event.name === name && !event.ctrl && !event.alt && !event.shift;

const USAGE_LIMIT_SCREEN = 'usage-limit';
const PLAN_BLOCK_SCREEN = 'plan-block';
const TOOL_VIEW_SCREEN = 'tool-view';

export const exitHint = (key: string): string => `Press ${key} again to exit`;

type ExitAction = Extract<ActionId, 'prompt.interrupt' | 'prompt.exit'>;

const MENU_CONTEXTS: readonly KeyContext[] = ['menu'];
const SHELL_CONTEXTS: readonly KeyContext[] = ['shell'];
const EDITOR_CONTEXTS: readonly KeyContext[] = ['chat', 'global'];
const AGENT_LIST_CONTEXTS: readonly KeyContext[] = ['agents'];

type Phase = { kind: 'starting' } | { kind: 'trust'; path: string } | { kind: 'welcome' } | { kind: 'unconnected' } | { kind: 'ready' };

const NO_MODEL_NOTE = messageOf('noModelConnected', 'tui');
const RESUBMIT_NOTICE = 'Signed in again. Retrying your last prompt.';

const PLAN_BLOCK_CODES: ReadonlySet<string> = new Set([PLAN_USE_NOT_ENABLED_CODE, PLAN_NOT_ELIGIBLE_CODE]);

const isUsageLimitCode = (code: string): boolean => USAGE_LIMIT_CODES.some((member) => member === code);

const CLEAR_SCREEN = '\u001b[2J\u001b[H';

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

type Replay = { queue: ReplayQueue; before: number; notes: NoteReplay | undefined };

type ScreenFacts = { overlay: boolean; position: Position; tasks: BackgroundTasks; terminal: ScreenTerminal; flush(): Promise<void> };

type Pointed = { readonly place: 'panel' | 'menu' | 'agents' | 'viewport'; readonly row: number; readonly range: readonly [number, number] | undefined };

type Hovered = Pointed & { readonly screen: string; readonly at: MouseEvent };

export function App(props: AppProps) {
  const { backend, terminal, onExit } = props;
  const { exit, waitUntilRenderFlush } = useApp();
  const { stdout, write: writeThroughInk } = useStdout();
  const terminalState = useSyncExternalStore(terminal.subscribe, terminal.state);
  const scrollbackReady = useBackgroundAnswered(terminalState.negotiation, props.timers);
  const { columns, rows } = terminalState.size;
  applyAppearance(appearanceOf(props.colour ?? UNREPORTED_COLOUR_HOST, terminalState.backgroundColor));
  const tuiSettings = props.tuiSettings ?? UNSTORED_TUI_SETTINGS;
  const [theme, setTheme] = useState<ThemeId>(tuiSettings.initial.theme);
  const [previewedTheme, setPreviewedTheme] = useState<ThemeId | undefined>(undefined);
  const [notify, setNotify] = useState<NotifyMode>(tuiSettings.initial.notify);
  const [copyOnSelect, setCopyOnSelect] = useState<boolean>(props.copyOnSelect ?? tuiSettings.initial.copyOnSelect);
  applyTheme(previewedTheme ?? theme);
  const [storedA11y, setStoredA11y] = useState<StoredA11y>({ screenReader: tuiSettings.initial.screenReader, reducedMotion: tuiSettings.initial.reducedMotion });
  const a11y = a11yOf(storedA11y, props.a11y ?? NOTHING_ASKED);
  applyA11y(a11y);
  const [store] = useState(() => {
    const created = createTranscriptStore();
    if (props.startup !== undefined) created.append({ kind: 'banner', banner: { config: props.startup, model: { kind: 'unread' }, cwd: backend.cwd, notices: [], figure: true } }, BANNER_KEY);
    return created;
  });
  const [origins] = useState(() => createOrigins(store));
  useEffect(() => origins.stop, [origins]);
  const visible = store.shown();
  useSyncExternalStore(visible.subscribe, visible.version);
  const transcript = visible.state();
  const [agents, setAgents] = useState(createAgentViews);
  const agentsRef = useRef(agents);
  useSyncExternalStore(agents.subscribe, agents.version);
  const shownAgent = agents.shown();
  const viewedLive = shownAgent?.store ?? store;
  const viewed = viewedLive.shown();
  useSyncExternalStore(viewed.subscribe, viewed.version);
  const [listFocus, setListFocus] = useState<ViewTarget | undefined>(undefined);
  const listFocusRef = useRef<ViewTarget | undefined>(undefined);
  const listTargetsRef = useRef<readonly ViewTarget[]>([]);
  const listSeen = useRef<{ rows: string; drawn: boolean }>({ rows: '', drawn: false });
  const listPress = useRef<{ row: number; col: number } | undefined>(undefined);
  const renderedScreen = useRef<string | undefined>(undefined);
  const drawnScreen = useRef<string | undefined>(undefined);
  const arrivals = useRef(0);
  const arrivedScreen = useRef<string | undefined>(undefined);
  const frameWatch = useRef<{ readonly terminal: ScreenTerminal; readonly stop: () => void } | undefined>(undefined);
  const answerMark = useRef<{ readonly arrival: number; sync: boolean } | undefined>(undefined);
  const followingKeys = useRef<Array<{ readonly event: KeyEvent; readonly pressed: KeyTable; readonly arrival: number }>>([]);
  const drainingKeys = useRef(false);
  const unmounted = useRef(false);
  const activeKeyArrival = useRef<number | undefined>(undefined);
  const pendingQueue = useRef<{ readonly arrival: number; cancel(): void } | undefined>(undefined);
  const cancelPendingRun = useRef(false);
  const opSeq = useRef(0);
  const runSeq = useRef(0);
  const { now, timers } = props;
  const [openedAt] = useState(now);
  const baseSlash = props.slash ?? createSlashRegistry(DEFAULT_SLASH_COMMANDS);
  const ownTasks = useRef<BackgroundTasks>(props.tasks ?? createBackgroundTasks());
  const tasks = props.tasks ?? ownTasks.current;
  const lastAutoNotice = useRef<AutoNoticePair | undefined>(undefined);
  const [skillSlash, setSkillSlash] = useState<readonly SlashCommand[]>([]);
  const delegatingFlows: PlanFlows = {
    login: (args) => flows.login(args),
    logout: () => flows.logout(),
    modelPicker: (current) => flows.modelPicker(current),
    providerFlow: (profile) => flows.providerFlow(profile),
    catalogPicker: (profile, account) => flows.catalogPicker(profile, account),
    welcome: (listed) => flows.welcome(listed),
    usageLimit: (profile) => flows.usageLimit(profile),
    planUseNotEnabled: (profile, account) => flows.planUseNotEnabled(profile, account),
    notEligible: (profile) => flows.notEligible(profile),
  };
  const slash = createSlashRegistry([...sessionSlashCommands(baseSlash.list(), delegatingFlows), ...skillSlash]);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  const [mode, setModeState] = useState<PermissionMode>(props.initialMode ?? DEFAULT_PERMISSION_MODE);
  const [bypassAllowed, setBypassAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<MomongaModelEntry | undefined>(undefined);
  const [sessionModel, setSessionModel] = useState<string | undefined>(undefined);
  const [sessionEffort, setSessionEffort] = useState<ReasoningEffort | undefined>(undefined);
  const [sessionOutputStyle, setSessionOutputStyle] = useState<OutputStyle | undefined>(undefined);
  const entriesRef = useRef<readonly MomongaModelEntry[]>([]);
  const sessionEffortRef = useRef<ReasoningEffort | undefined>(undefined);
  const effortNotedRef = useRef(false);
  const [entriesVersion, setEntriesVersion] = useState(0);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [displays, setDisplays] = useState<ReadonlyMap<string, string>>(new Map());
  const displaysRef = useRef<ReadonlyMap<string, string>>(new Map());
  const [found] = useState(createFoundServers);
  const [modelChanges] = useState(createKeyedSerializer);
  const unconfiguredModel = useRef(false);
  const capabilities: ChainCapabilities | undefined = model === undefined || isNotListedCapabilities(model.capabilities) ? undefined : model.capabilities;
  const [attachments, setAttachmentsState] = useState<readonly Attachment[]>([]);
  const [attachOn, setAttachOn] = useState(tuiSettings.initial.attachFileMentions);
  const imageCount = useRef(0);
  const shellRunning = useRef(false);
  const [reconnectingSince, setReconnectingSince] = useState<number | undefined>(undefined);
  const [measuring, setMeasuring] = useState<{ since: number; state: Measuring } | undefined>(undefined);
  const [commands, setCommands] = useState<readonly WaitingPhase[]>([]);
  const [probe, setProbe] = useState<{ sessionId: string | undefined; model: string; retryAfterSeconds: number } | undefined>(undefined);
  const [followedSession, setFollowedSession] = useState<{ id: string; after: number; cwd: string } | undefined>(undefined);
  const [switching, setSwitching] = useState(false);
  const [hovered, setHovered] = useState<Hovered | undefined>(undefined);
  const hoveredRef = useRef<Hovered | undefined>(undefined);
  const [historyGeneration, setHistoryGeneration] = useState(0);
  const { adoption, move } = props;
  const [feed, setFeed] = useState(() => createHistoryFeed(adoption?.record.printed ?? 0));
  const feedRef = useRef(feed);
  const sourceRef = useRef<ViewSource | undefined>(undefined);
  const [erased, setErased] = useState(false);
  const phaseRef = useRef<Phase['kind']>('starting');
  const readingRef = useRef(false);
  const switchingRef = useRef(false);
  const startsFromRecord = useRef(adoption !== undefined);
  const [panelRows, setPanelRows] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState<Loading | undefined>(undefined);
  const openedSession = useRef<{ id: string; hasRun: boolean } | undefined>(undefined);
  const initialPromptSent = useRef(false);
  const exiting = useRef(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<EditorState>(editor);
  const attachmentsRef = useRef<readonly Attachment[]>([]);
  const [waitingMessages, setWaitingState] = useState<readonly InboxRowView[]>([]);
  const waitingRef = useRef<readonly InboxRowView[]>([]);
  const lastEndedRun = useRef<string | undefined>(undefined);
  const followingQueued = useRef(false);
  const betweenRuns = useRef(false);
  const [profiles, setProfiles] = useState<readonly PlanProfileView[]>([]);
  const [servedTarget, setServedTarget] = useState<string | undefined>(undefined);
  const typedRef = useRef(false);
  const sessionModelRef = useRef<string | undefined>(undefined);
  const signInFailedRun = useRef<{ text: string; options: StartRunOptions; sessionModel: string } | undefined>(undefined);
  const busyRef = useRef(false);
  const promptNotes = useRef<readonly string[]>([]);
  const sentMessages = useRef(new Map<string, { message: HeldMessage; attachments: readonly Attachment[] }>());
  const facts = useRef<ScreenFacts>({ overlay: false, position: FOLLOWING, tasks, terminal, flush: waitUntilRenderFlush });
  const [handover] = useState(() => {
    let suspended = false;
    let undrawn: LocalNote[] = [];
    const appendLocal = (entry: Entry): void => {
      if (isLocalNote(entry)) {
        origins.noted(entry);
        if (suspended) {
          undrawn.push(entry);
          return;
        }
      }
      appendEntry(store, entry);
    };
    const snapshot = (): TuiSnapshot | undefined => {
      const opened = openedSession.current;
      if (opened === undefined) return undefined;
      const state = facts.current.terminal.state();
      const current = editorRef.current;
      return {
        kind: 'tui',
        session: opened.id,
        lastSeq: origins.applied(),
        neg: state.negotiation,
        hint: NEWLINE_HINT[state.negotiation],
        size: state.size,
        ...(state.screen === 'fullscreen' ? { view: viewOf(facts.current.position, origins), toggles: togglesOf(store) } : { printed: feedRef.current.handed() }),
        input: { text: current.text, cursor: current.cursor, historyIndex: current.historyIndex ?? null, draft: current.draft, draftPastes: current.draftPastes.map((paste) => ({ ...paste })), pastes: current.pastes.map((paste) => ({ ...paste })), pasteCount: current.pasteCount, shell: current.shell, draftShell: current.draftShell },
        attachments: heldAttachments(attachmentsRef.current, current.pastes).map((attachment) => ({ file: attachment.file, sha256: attachmentDigest(attachment.image) })),
        notes: origins.notes(),
      };
    };
    const quiet = (own: OwnGeneration): boolean => {
      const state = store.state();
      const now = facts.current;
      if (openedSession.current === undefined || phaseRef.current !== 'ready' || now.overlay) return false;
      if (readingRef.current || switchingRef.current || shellRunning.current || now.tasks.count() > 0) return false;
      if ((state.approval !== undefined && own === 'live') || state.elicitation !== undefined) return false;
      return now.terminal.state().screen === 'fullscreen' || sourceRef.current === undefined || !feedRef.current.pending(sourceRef.current, store.settledAt);
    };
    const surface: TuiSurface = {
      session: () => openedSession.current?.id,
      quiet,
      snapshot,
      suspend: async () => {
        suspended = true;
        if (facts.current.terminal.state().screen !== 'scrollback') return;
        setErased(true);
        await facts.current.flush();
      },
      resume: () => {
        suspended = false;
        setErased(false);
        const kept = undrawn;
        undrawn = [];
        for (const entry of kept) appendEntry(store, entry);
      },
      say: (text) => appendLocal({ kind: 'info', text }),
    };
    return { appendLocal, surface };
  });
  const fixedKeys = props.keys ?? DEFAULT_KEY_TABLE;
  const fixedBindings = useMemo(() => fixedKeyBindings(fixedKeys), [fixedKeys]);
  const bindings = props.keyBindings ?? fixedBindings;
  const keys = useSyncExternalStore(bindings.subscribe, bindings.table);
  const chord = useRef<KeySpec | undefined>(undefined);
  const warn = useEffectEvent((text: string): void => handover.appendLocal({ kind: 'notice', level: 'warning', text }));
  useEffect(() => bindings.listen((text) => warn(text)), [bindings]);
  const externalEditor = props.externalEditor ?? unavailableExternalEditor;
  const [hint, setHint] = useState<string | undefined>(undefined);
  const armedExit = useRef<{ action: ExitAction; timer: unknown } | undefined>(undefined);
  const waitingNotice = (): WaitingNotice | undefined => {
    if (phase.kind === 'trust') return { heading: trustHeading(phase.path), namesFolder: true };
    const { approval, elicitation } = transcript;
    if (approval !== undefined) return { heading: approvalHeading(approval, approvalWording(approval, (callId) => toolOf(store, callId)).title), namesFolder: false };
    if (elicitation !== undefined) return { heading: elicitationHeading(elicitation, toolOf(store, elicitation.callId)?.title ?? elicitation.callId), namesFolder: false };
    return undefined;
  };
  const attention = useAttention({
    terminal,
    cwd: backend.cwd,
    working: busy,
    waiting: waitingNotice(),
    notify,
    attentionTerminal: props.attentionTerminal ?? UNKNOWN_ATTENTION_TERMINAL,
    timers,
    reducedMotion: a11y.reducedMotion,
  });

  const enterPhase = (next: Phase): void => {
    phaseRef.current = next.kind;
    setPhase(next);
    const shown = store.byKey(BANNER_KEY)?.entry;
    if (shown?.kind === 'banner') showBanner(bannerModelIn(next.kind, sessionModelRef.current, sessionEffortRef.current), shown.banner.notices, shown.banner.figure);
  };

  const renewHistory = (): void => {
    const fresh = createHistoryFeed();
    feedRef.current = fresh;
    setFeed(fresh);
    setHistoryGeneration((generation) => generation + 1);
  };

  const setBusyState = (value: boolean): void => {
    busyRef.current = value;
    setBusy(value);
  };

  const setAttachments = (next: readonly Attachment[]): void => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  };

  const replaceEditor = (next: EditorState): void => {
    editorRef.current = next;
    setEditor(next);
  };

  const append = handover.appendLocal;

  const finish = (outcome: TuiOutcome): void => {
    exiting.current = true;
    const opened = openedSession.current;
    onExit(opened?.hasRun === true ? { ...outcome, reopen: opened.id } : outcome);
    exit();
  };

  const fail = (error: unknown): void => {
    finish({ error: errorOf(error) });
  };

  const note = (text: string): void => {
    append({ kind: 'info', text });
  };

  const warningNote = (text: string): void => {
    append({ kind: 'notice', level: 'warning', text });
  };

  const failedNote = (text: string): void => {
    append({ kind: 'error', text });
  };

  const runCancellable = <T,>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const step = currentStep();
    opSeq.current += 1;
    const seq = opSeq.current;
    return tasks.run(
      async (signal) => {
        if (signal.aborted) throw new Abandoned();
        try {
          return await untilAborted(signal, work(signal));
        } catch (error) {
          if (signal.aborted) throw new Abandoned();
          throw error;
        }
      },
      step === undefined ? { seq } : { signal: step.signal, seq },
    );
  };

  const waitFor = <T,>(phase: string, work: (signal: AbortSignal) => Promise<T>, words: string = phase): Promise<T> => {
    const shown = prompts.waitWords(words);
    const waiting: WaitingPhase = { text: phase, startedAt: now() };
    if (shown === undefined) setCommands((running) => [...running, waiting]);
    return runCancellable(work).finally(() => {
      shown?.();
      setCommands((running) => running.filter((other) => other !== waiting));
    });
  };

  const reportError = (error: unknown): void => {
    append({ kind: 'error', text: describeFailure(error) });
  };

  const reportFlowError = (error: unknown): void => {
    if (!isAbandoned(error)) reportError(error);
  };

  const shownModel = (stored: string): string => displaysRef.current.get(stored) ?? stored;

  const displaysSettled = useRef<Promise<void>>(Promise.resolve());

  const readDisplays = (): Promise<ReadonlyMap<string, string>> => {
    const reading = listDisplays();
    displaysSettled.current = reading.then(
      () => undefined,
      () => undefined,
    );
    return reading;
  };

  const listDisplays = async (): Promise<ReadonlyMap<string, string>> => {
    const entries = await backend.models();
    entriesRef.current = entries;
    setEntriesVersion((version) => version + 1);
    const read = displayMapOf(listingViewsOf(entries));
    displaysRef.current = read;
    setDisplays(read);
    store.update({ shownModels: read });
    return read;
  };

  const bannerOf = (shownModel: BannerModel, shownNotices: readonly string[], figure: boolean): StartupBanner | undefined =>
    props.startup === undefined ? undefined : { config: props.startup, model: shownModel, cwd: backend.cwd, notices: shownNotices, figure };

  const connectedModel = (stored: string, chosen?: ReasoningEffort): BannerModel => {
    const effort = shownEffort(entriesRef.current, stored, chosen);
    return { kind: 'connected', name: shownModel(stored), ...(effort === undefined ? {} : { effort }) };
  };

  const noteEffortChoice = (model: string, chosen: ReasoningEffort | undefined): void => {
    const inForce = effortInForce(entriesRef.current, model, chosen);
    if (inForce === undefined || effortNotedRef.current) return;
    const declared = declaredReasoning(entriesRef.current, model);
    if (!declared.known) return;
    effortNotedRef.current = true;
    const text = effortChoiceText(declared, inForce, shownModel(model));
    if (text !== undefined) note(text);
  };

  const rereadModel = (): void => {
    void backend.model().then((entry) => showModel(entry, false), modelUnread);
  };

  const applyEffort = async (chosen: ReasoningEffort | null): Promise<void> => {
    overlayPorts.closeScreen();
    const session = await runCancellable(() => backend.setEffort(chosen));
    sessionEffortRef.current = session.effort;
    setSessionEffort(session.effort);
    rereadModel();
  };

  const applyOutputStyle = async (chosen: OutputStyle | null): Promise<void> => {
    overlayPorts.closeScreen();
    if (backend.setOutputStyle === undefined) return;
    const session = await runCancellable(() => backend.setOutputStyle!(chosen));
    setSessionOutputStyle(session.outputStyle);
  };

  const bannerModelIn = (kind: Phase['kind'], model: string | undefined, effort: ReasoningEffort | undefined): BannerModel => {
    if (kind === 'starting' || kind === 'trust') return { kind: 'unread' };
    return kind === 'ready' && model !== undefined ? connectedModel(model, effort) : { kind: 'not-connected', login: kind === 'unconnected' };
  };

  const showBanner = (shownModel: BannerModel, shownNotices: readonly string[], figure: boolean): void => {
    const banner = bannerOf(shownModel, shownNotices, figure);
    if (banner === undefined) return;
    if (store.byKey(BANNER_KEY) === undefined) store.append({ kind: 'banner', banner }, BANNER_KEY);
    else store.change(BANNER_KEY, () => ({ kind: 'banner', banner }));
  };

  const resetTranscript = (): void => {
    const fresh = createAgentViews();
    agentsRef.current = fresh;
    setAgents(fresh);
    chooseRow(undefined);
    store.reset();
    renewHistory();
    if (sessionModelRef.current !== undefined) showBanner(connectedModel(sessionModelRef.current, sessionEffortRef.current), notices, true);
  };

  const switchScreen = async (next: ScreenMode): Promise<void> => {
    if (terminal.state().screen !== next) {
      switchingRef.current = true;
      setSwitching(true);
      await waitUntilRenderFlush();
      terminal.setScreen(next);
      renewHistory();
      switchingRef.current = false;
      setSwitching(false);
    }
    note(`screen: ${next}`);
  };

  const showAutoNotice = (session: SessionView): void => {
    const view = session.autoClassifier;
    if (session.permissionMode !== 'auto' || view === undefined) return;
    if (!autoNoticeDue(lastAutoNotice.current, view)) return;
    lastAutoNotice.current = { key: view.key, measurement: view.measurement };
    note(autoModeNotice({ view, surface: 'tui', shownModel: displays.get(view.model) ?? view.model }));
  };

  const endMeasuring = (): void => {
    setProbe(undefined);
    setMeasuring(undefined);
  };

  const modelUnread = (error: unknown, announce = true): void => {
    endMeasuring();
    if (announce) warningNote(modelUnreadText(error));
  };

  const showModel = (entry: MomongaModelEntry, announce = true): void => {
    endMeasuring();
    setModel(entry);
    entriesRef.current = [...entriesRef.current.filter((known) => known.id !== entry.id), entry];
    setEntriesVersion((version) => version + 1);
    if (announce && entry.id === sessionModelRef.current) noteEffortChoice(entry.id, sessionEffortRef.current);
    const readiness = agentReadiness(entry.capabilities);
    if (readiness.state === 'probing') {
      setMeasuring({ since: now(), state: readiness.measuring });
      setProbe({ sessionId: openedSession.current?.id, model: entry.id, retryAfterSeconds: readiness.retryAfterSeconds });
      return;
    }
    const text = readinessNoticeOf(readiness, 'tui');
    if (text !== undefined && announce) append({ kind: 'notice', level: 'warning', text });
  };

  const showSession = async (session: SessionView): Promise<void> => {
    openedSession.current = { id: session.id, hasRun: session.latestRunId !== null };
    const reading = readDisplays();
    setFollowedSession((before) => (before?.id === session.id ? before : { id: session.id, after: session.lastEventId, cwd: session.cwd }));
    setModeState(session.permissionMode);
    sessionModelRef.current = session.model;
    setSessionModel(session.model);
    setSessionEffort(session.effort);
    setSessionOutputStyle(session.outputStyle);
    setBypassAllowed(session.bypassAllowed);
    const configured = (await reading).has(session.model);
    unconfiguredModel.current = !configured;
    sessionEffortRef.current = session.effort;
    effortNotedRef.current = false;
    showBanner(connectedModel(session.model, session.effort), notices, true);
    const announce = !startsFromRecord.current;
    if (announce) noteEffortChoice(session.model, session.effort);
    if (announce) showAutoNotice(session);
    enterPhase({ kind: 'ready' });
    endMeasuring();
    if (!configured) {
      if (announce) append({ kind: 'notice', level: 'warning', text: notConfiguredAnyMoreText(session.model) });
      return;
    }
    void backend.model().then(
      (entry) => showModel(entry, announce),
      (error: unknown) => modelUnread(error, announce),
    );
  };

  const enterFirstSession = async (session: SessionView): Promise<void> => {
    await showSession(session);
    const announce = !startsFromRecord.current;
    startsFromRecord.current = false;
    const history = await backend.loadHistory();
    replaceEditor(withHistory(editorRef.current, history));
    void backend.startupNotices().then(
      (found) => setNotices((previous) => [...previous, ...found]),
      (error: unknown) => {
        if (announce) append({ kind: 'notice', level: 'warning', text: `startup notices unavailable: ${errorOf(error).message}` });
      },
    );
    void backend.skills().then(
      ({ skills }) => {
        const taken = new Set(baseSlash.list().flatMap(namesOf));
        const loaded = skillCommands(skills, taken);
        setSkillSlash(loaded.commands);
        if (loaded.shadowed.length > 0 && announce) note(`skills shadowed by a built-in command and reachable only through the model: ${loaded.shadowed.join(', ')}`);
      },
      (error: unknown) => {
        if (announce) append({ kind: 'notice', level: 'warning', text: `skills unavailable: ${errorOf(error).message}` });
      },
    );
  };

  const openSession = async (chosen: string | undefined, effort?: ReasoningEffort): Promise<void> => enterFirstSession(await backend.openSession(chosen, undefined, effort));

  const runFlow = (work: () => Promise<void>): void => {
    prompts.flow(work).catch(reportFlowError);
  };

  const switchModel = async (chosen: string, effort: ReasoningEffort | undefined): Promise<SessionView> => {
    const session = await backend.setModel(chosen, effort);
    modelChosen(store);
    sessionModelRef.current = session.model;
    setSessionModel(session.model);
    sessionEffortRef.current = session.effort;
    setSessionEffort(session.effort);
    unconfiguredModel.current = false;
    await readDisplays();
    endMeasuring();
    void backend.model().then(showModel, modelUnread);
    return session;
  };

  const noteModelSwitch = async (model: string, previous: string | undefined, switched: SessionView | undefined): Promise<void> => {
    const name = shownModel(model);
    const shown = shownEffort(await backend.models(), model, sessionEffortRef.current);
    const named = shown === undefined ? name : modelWithEffort(name, effortLine(shown, 'short'));
    note(busyRef.current ? `model: ${named}; the run that is working keeps ${previous === undefined ? previous : shownModel(previous)}, the next run uses ${name}` : `model: ${named}; applies from the next run`);
    if (switched !== undefined) showAutoNotice(switched);
  };

  const changeSessionModel = <T,>(work: () => Promise<T>, signal = new AbortController().signal): Promise<T> =>
    modelChanges('session model', work, signal);

  const applyModel = (chosen: string, effort?: ReasoningEffort): Promise<void> =>
    changeSessionModel(async () => {
      const previous = sessionModelRef.current;
      const switched = await switchModel(chosen, effort);
      await noteModelSwitch(switched.model, previous, switched);
    });

  const rememberProfiles = (listed: PlanAccountsResponse): void => {
    setProfiles(listed.profiles);
  };

  const connectModel = async (chosen: string): Promise<void> => {
    overlayPorts.closeScreen();
    await runCancellable((signal) => changeSessionModel(async () => {
      const previous = sessionModelRef.current;
      if (previous === undefined) {
        await openSession(chosen);
        return;
      }
      const switched = await switchModel(chosen, undefined);
      await noteModelSwitch(switched.model, previous, switched);
    }, signal));
  };

  const switchModelThen = async (chosen: string, effort: ReasoningEffort | undefined, then: () => Promise<void>): Promise<void> => {
    overlayPorts.closeScreen();
    const { model, previous, switched } = await runCancellable((signal) => changeSessionModel(async (): Promise<{ model: string; previous: string | undefined; switched: SessionView | undefined }> => {
      const previous = sessionModelRef.current;
      if (previous !== undefined) {
        const switched = await switchModel(chosen, effort);
        return { model: switched.model, previous, switched };
      }
      await openSession(chosen, effort);
      return { model: chosen, previous, switched: undefined };
    }, signal));
    const failure = await then().then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    if (failure === undefined) {
      await noteModelSwitch(model, previous, switched);
      return;
    }
    await noteModelSwitch(model, previous, switched).then(
      () => Promise.reject(failure.error),
      () => Promise.reject(failure.error),
    );
  };

  const refreshConnection = (): Promise<void> =>
    changeSessionModel(async () => {
      rememberProfiles(await backend.plan.accounts());
      const current = sessionModelRef.current;
      if (current !== undefined) {
        unconfiguredModel.current = !(await readDisplays()).has(current);
        if (unconfiguredModel.current) endMeasuring();
        else rereadModel();
        return;
      }
      if ((await backend.models()).length > 0) await openSession(undefined);
      else enterPhase({ kind: 'unconnected' });
    });

  const setWaitingMessages = (rows: readonly InboxRowView[]): void => {
    waitingRef.current = rows;
    setWaitingState(rows);
  };

  const refreshInbox = async (): Promise<void> => {
    setWaitingMessages(await backend.inbox.list());
  };

  const cancelNewest = (): void => {
    const queued = pendingQueue.current;
    const keyArrival = activeKeyArrival.current ?? arrivals.current;
    if (queued !== undefined && queued.arrival === keyArrival) {
      pendingQueue.current = undefined;
      queued.cancel();
      return;
    }
    const runActive = runIdRef.current !== undefined || (busyRef.current && !betweenRuns.current);
    if (tasks.active() && (!runActive || tasks.newestSeq() > runSeq.current)) {
      tasks.abortNewest();
      return;
    }
    const runId = runIdRef.current;
    if (runId !== undefined) {
      backend.cancel(runId).catch(reportError);
      return;
    }
    if (busyRef.current) {
      cancelPendingRun.current = true;
      return;
    }
    tasks.abortNewest();
  };

  const decideTrust = (decision: 'trusted' | 'untrusted'): void => {
    const decide = async (): Promise<void> => {
      await backend.decideTrust(decision);
      await connectAtLaunch();
    };
    decide().catch(fail);
  };

  const prompts = usePrompts({
    backend,
    store,
    terminal,
    keepTyped: (text) => replaceEditor(typedIntoDraft(editorRef.current, text)),
    columns,
    panelRows: panelRowsCap(rows),
    keys,
    screenReader: a11y.screenReader,
    interruptRun: () => cancelAndArmExit('prompt.interrupt'),
    stopActive: () => cancelNewest(),
    reportError,
    fail,
    exit: () => finish({}),
    append,
    decideTrust,
    externalEditor,
  });
  const { overlayPorts, overlay } = prompts;

  const resubmitAfterSignIn = async (): Promise<void> => {
    const kept = signInFailedRun.current;
    if (kept === undefined) return;
    const [entries, health] = await Promise.all([backend.models(), backend.health()]);
    const entry = entries.find((candidate) => candidate.id === kept.sessionModel);
    if (entry === undefined || !entry.chain.some((member) => health.models[member.model]?.ok === true)) return;
    signInFailedRun.current = undefined;
    note(RESUBMIT_NOTICE);
    await runPrompt(kept.text, kept.options);
  };

  const flows: PlanFlows = createPlanFlows({ ...overlayPorts, backend, info: note, failed: failedNote, toast: (text) => view.showToast(text), warn: warningNote, connected: connectModel, switchedThen: switchModelThen, effort: () => sessionEffortRef.current, setEffort: applyEffort, shownModel, timers, refreshConnection, signedIn: resubmitAfterSignIn, found, model: () => sessionModelRef.current, wait: waitFor, cancellable: runCancellable, invitationAnswered: () => prompts.dismissInvitation(), untilNextKey: () => untilNextKey(terminal.input) });

  const showUsageLimit = async (code: string, plan: PlanAccountRef): Promise<void> => {
    const listed = await backend.plan.accounts();
    rememberProfiles(listed);
    const profile = profileOf(listed.profiles, plan.profile);
    append({ kind: 'notice', level: 'warning', text: `${profile.messages.identityLabel}\n${profile.messages.usageLimitMessage}` });
    if (code !== USAGE_PAUSED_CODE) await prompts.raise(USAGE_LIMIT_SCREEN, () => flows.usageLimit(profile));
  };

  const showPlanBlock = async (error: { code: string; message: string }, plan: PlanAccountRef): Promise<void> => {
    const listed = await backend.plan.accounts();
    rememberProfiles(listed);
    const profile = profileOf(listed.profiles, plan.profile);
    append({ kind: 'notice', level: 'error', text: `${profile.messages.identityLabel}\n${error.message}` });
    await prompts.raise(PLAN_BLOCK_SCREEN, () => (error.code === PLAN_USE_NOT_ENABLED_CODE ? flows.planUseNotEnabled(profile, plan.account) : flows.notEligible(profile)));
  };

  const offerInvitation = async (listed: PlanAccountsResponse): Promise<void> => {
    const dismissed = await backend.dismissedNotices();
    const invited = listed.profiles.find((profile) => accountsOf(profile.id, listed.accounts).length === 0 && !Object.hasOwn(dismissed, invitationKeyOf(profile.id)));
    if (invited === undefined || typedRef.current) return;
    prompts.invite({ profile: invited });
  };

  const connectAtLaunch = async (): Promise<void> => {
    await prompts.flow(async () => {
      const pending = await backend.trustItems();
      for (const sentence of pending.refused) append({ kind: 'notice', level: 'warning', text: sentence });
      const approved = await askTrustItems(pending.items, overlayPorts.choose);
      if (approved.length > 0) await backend.approveProjectItems(approved);
      const proposal = await backend.checkProposal();
      const check = proposal.ask ? await askProjectCheck(proposal.checks, overlayPorts) : undefined;
      if (check !== undefined) await backend.answerCheck(check);
    });
    const [entries, listed] = await Promise.all([backend.models(), backend.plan.accounts()]);
    rememberProfiles(listed);
    if (entries.length > 0) {
      await openAtLaunch();
      runFlow(() => offerInvitation(listed));
      return;
    }
    if (listed.accounts.length === 0) {
      enterPhase({ kind: 'welcome' });
      runFlow(async () => {
        try {
          await flows.welcome(listed.profiles);
        } finally {
          if (sessionModelRef.current === undefined) enterPhase({ kind: 'unconnected' });
        }
      });
      return;
    }
    enterPhase({ kind: 'unconnected' });
    const usable = listed.accounts.find((account) => account.active && (account.state === 'active' || account.state === PLAN_DISABLED_STATE));
    if (usable !== undefined) runFlow(async () => {
      await flows.catalogPicker(profileOf(listed.profiles, usable.profile), usable.label);
    });
  };

  const boot = useEffectEvent(async (): Promise<void> => {
    try {
      const trust = await backend.boot();
      if (trust.decision === null) {
        enterPhase({ kind: 'trust', path: trust.path });
        return;
      }
      await connectAtLaunch();
    } catch (error) {
      fail(error);
    }
  });

  useEffect(() => {
    void boot();
  }, [backend]);

  const disarmExit = (): void => {
    const armed = armedExit.current;
    if (armed === undefined) return;
    timers.clearTimeout(armed.timer);
    armedExit.current = undefined;
    setHint(undefined);
  };

  const follow = (runId: string, replay: Replay | undefined): Promise<RunView> => {
    const views = agentsRef.current;
    let firstSeq: number | undefined;
    const deliver = (work: () => void, position?: number): void => {
      if (replay === undefined) work();
      else replay.queue.push(work, position);
    };
    return backend.follow(runId, {
      onEvent: (frame) => {
        const event = frame.data;
        if (isOpaqueEvent(event)) {
          deliver(() => setReconnectingSince(undefined), undefined);
          return;
        }
        const seq = 'seq' in event ? event.seq : undefined;
        firstSeq ??= seq;
        const first = firstSeq;
        const key = 'seq' in event ? { runId: event.runId, seq: event.seq } : undefined;
        deliver(
          () => {
            setReconnectingSince(undefined);
            if (key !== undefined) origins.at(key);
            if (event.type === 'model.responded' && event.target !== undefined) setServedTarget(event.target);
            if (event.type === 'user.message' && event.source !== undefined) refreshInbox().catch(reportError);
            if (replay === undefined) {
              foldLiveEvent(store, event, first);
              if (isPrompt(event, first)) showPromptNotes();
            } else foldReplayedEvent(store, event, first, (record) => showShellRecord(store, record, now()));
            if (key !== undefined) replay?.notes?.after(key);
          },
          replay === undefined || seq === undefined ? undefined : replay.before + seq,
        );
      },
      onChildEvent: (frame, agent) =>
        deliver(() => {
          setReconnectingSince(undefined);
          const event = frame.data;
          if (isOpaqueEvent(event)) return;
          const key = 'seq' in event ? { runId: event.runId, seq: event.seq } : undefined;
          if (key !== undefined) origins.at(key);
          foldChildEvent(store, event, agent);
          views.event(event);
          if (key !== undefined) replay?.notes?.after(key);
        }),
      onChildStarted: (agent, childRunId, backlog, model, effort) =>
        deliver(() => {
          views.started(agent, childRunId, backlog, model, effort);
          subagentStarted(store, agent, childRunId, now());
        }),
      onChildEnded: (_agent, childRunId, end) =>
        deliver(() => {
          subagentEnded(store, childRunId);
          views.ended(childRunId, end);
          if (!agentListDrawn(store.state().subagents, agentsRef.current.shown()?.runId)) chooseRow(undefined);
        }),
      onReconnecting: () => setReconnectingSince((since) => since ?? now()),
      onDaemonStopping: () => {
        append({ kind: 'notice', level: 'info', text: DAEMON_STOPPING_TEXT });
      },
    });
  };

  const showRunEnd = (run: RunView): void => {
    if (run.status === 'CANCELLED') append({ kind: 'notice', level: 'info', text: describeRunEnd(run, 'tui') });
    else if (run.status !== 'COMPLETED') append({ kind: 'error', text: describeRunEnd(run, 'tui') });
  };

  const watchRun = async (runId: string, replay: Replay | undefined, resubmit: { text: string; options: StartRunOptions; sessionModel: string } | undefined): Promise<void> => {
    runIdRef.current = runId;
    const followedAt = now();
    const run = await follow(runId, replay);
    await replay?.queue.drained();
    setReconnectingSince(undefined);
    attention.runEnded(run.status === 'COMPLETED' ? { kind: 'done', elapsedMs: now() - followedAt } : run.status === 'FAILED' ? { kind: 'error', reason: endReasonLines(run, 'tui')[0] } : undefined);
    const stopped = run.error;
    if (run.status === 'FAILED' && stopped?.code === SIGN_IN_REQUIRED_CODE && resubmit !== undefined) signInFailedRun.current = resubmit;
    const plan = stopped?.plan;
    if (stopped !== undefined && plan !== undefined && isUsageLimitCode(stopped.code)) runFlow(() => showUsageLimit(stopped.code, plan));
    else if (stopped !== undefined && plan !== undefined && PLAN_BLOCK_CODES.has(stopped.code)) runFlow(() => showPlanBlock(stopped, plan));
    else showRunEnd(run);
  };

  const endReading = (): void => {
    readingRef.current = false;
    store.release();
    runIdRef.current = undefined;
    setReconnectingSince(undefined);
    runLeft(store);
    setLoading(undefined);
    setBusyState(false);
  };

  const restoreNote = (recorded: HandoverNote): void => {
    const entry = entryOfNote(recorded);
    origins.noted(entry, recorded.anchor);
    appendEntry(store, entry);
  };

  type Restored = { notes: readonly HandoverNote[]; caughtUp(): void };

  const readConversation = async (session: SessionView, enter: (session: SessionView) => Promise<void>, restored: Restored | undefined = undefined): Promise<void> => {
    readingRef.current = true;
    const runs = await backend.runs();
    const total = runs.reduce((sum, run) => sum + run.lastSeq, 0);
    const startedAt = now();
    setBusyState(true);
    setLoading({ done: 0, total, startedAt });
    try {
      await enter(session);
    } catch (error) {
      endReading();
      throw error;
    }
    const notes = restored === undefined ? undefined : createNoteReplay(restored.notes, restoreNote);
    let caught = false;
    const caughtUp = (): void => {
      if (caught) return;
      caught = true;
      readingRef.current = false;
      notes?.rest();
      restored?.caughtUp();
      store.release();
    };
    const queue = createReplayQueue(timers, (done) => {
      setLoading(done < total ? { done, total, startedAt } : undefined);
      if (done >= total) caughtUp();
    });
    store.hold();
    notes?.before();
    if (total === 0) caughtUp();
    try {
      let before = 0;
      for (const run of runs) {
        if (isTerminalStatus(run.status)) {
          const ended = await follow(run.id, { queue, before, notes });
          queue.push(() => {
            runLeft(store);
            showRunEnd(ended);
          }, before + run.lastSeq);
        } else {
          store.update({ runId: run.id });
          opSeq.current += 1;
          runSeq.current = opSeq.current;
          await watchRun(run.id, { queue, before, notes }, undefined);
          await watchQueuedRuns(run.id);
        }
        before += run.lastSeq;
      }
      await queue.drained();
      caughtUp();
      for (const record of await backend.userInput.pendingShell()) showShellRecord(store, record, now());
    } catch (error) {
      attention.runEnded({ kind: 'error', reason: describeFailure(error) });
      if (!exiting.current) reportError(error);
    } finally {
      endReading();
    }
  };

  const clearScreen = (): void => {
    signInFailedRun.current = undefined;
    resetTranscript();
    if (terminal.state().screen === 'scrollback') stdout.write(CLEAR_SCREEN);
  };

  const refusedWhileWorking = (): boolean => {
    if (busyRef.current) setHint(taskRunningHint(keys));
    return busyRef.current;
  };

  const startNewSession = async (): Promise<void> => {
    if (refusedWhileWorking()) return;
    if (sessionModelRef.current === undefined) {
      clearScreen();
      return;
    }
    const session = await backend.openSession(sessionModelRef.current, mode);
    clearScreen();
    await showSession(session);
  };

  const resumeSession = async (id: string): Promise<void> => {
    if (refusedWhileWorking()) return;
    const read = await overlayPorts.read(() => backend.resumeSession(id));
    if (read.kind === 'cancelled') return;
    await readConversation(read.value, async (session) => {
      clearScreen();
      await showSession(session);
    });
  };

  const resumePorts = { backend, pick: overlayPorts.pick, info: note, resume: resumeSession, now, columns: () => terminal.state().size.columns };

  const restoreInput = (input: HandoverInput): void => {
    replaceEditor({ ...editorRef.current, text: input.text, cursor: input.cursor, historyIndex: input.historyIndex ?? undefined, draft: input.draft ?? '', draftPastes: input.draftPastes ?? [], pastes: input.pastes ?? [], pasteCount: input.pasteCount ?? 0, shell: input.shell ?? false, draftShell: input.draftShell ?? false });
  };

  const readRecordedImage = async (file: string): Promise<{ image: ImageAttachment } | { reason: string }> => {
    try {
      return { image: await backend.readImage(file) };
    } catch (error) {
      return { reason: errorOf(error).message };
    }
  };

  const restoreAttachments = async (recorded: readonly HandoverAttachment[]): Promise<void> => {
    const kept: Attachment[] = [];
    for (const { file, sha256 } of recorded) {
      const read = await readRecordedImage(file);
      if ('reason' in read) append({ kind: 'notice', level: 'warning', text: attachmentUnreadableText(file, read.reason) });
      else if (attachmentDigest(read.image) !== sha256) append({ kind: 'notice', level: 'warning', text: attachmentChangedText(file) });
      else kept.push({ file, image: read.image });
    }
    if (kept.length > 0) setAttachments([...attachmentsRef.current, ...kept]);
  };

  const adoptSession = async ({ record, attached }: TuiAdoption): Promise<void> => {
    const enter = async (session: SessionView): Promise<void> => {
      await enterFirstSession(session);
      restoreInput(record.input);
    };
    const caughtUp = (): void => {
      if (record.toggles !== undefined) restoreToggles(store, record.toggles);
      if (record.view !== undefined) view.place(positionOf(record.view, origins));
      attached();
      restoreAttachments(record.attachments).catch(reportError);
    };
    await readConversation(await backend.resumeSession(record.session), enter, { notes: record.notes, caughtUp });
  };

  const openAtLaunch = async (): Promise<void> => {
    if (adoption !== undefined) {
      await adoptSession(adoption);
      return;
    }
    const { reopen } = props;
    if (reopen === undefined || reopen.kind === 'pick') {
      await openSession(undefined);
      if (reopen !== undefined) runFlow(() => pickConversation(resumePorts));
      return;
    }
    await readConversation(reopen.kind === 'id' ? await backend.resumeSession(reopen.id) : await backend.continueSession(), enterFirstSession);
  };

  const watchQueuedRuns = async (endedRunId: string): Promise<void> => {
    followingQueued.current = true;
    try {
      for (let ended = endedRunId; ; ) {
        lastEndedRun.current = ended;
        betweenRuns.current = true;
        await refreshInbox();
        const next = await backend.inbox.successor(ended);
        betweenRuns.current = false;
        if (next === undefined) return;
        runLeft(store);
        runCreated(store, next.id, now());
        opSeq.current += 1;
        runSeq.current = opSeq.current;
        await watchRun(next.id, undefined, undefined);
        ended = next.id;
      }
    } finally {
      betweenRuns.current = false;
      followingQueued.current = false;
    }
  };

  const resumeQueuedRuns = async (): Promise<void> => {
    const ended = lastEndedRun.current;
    if (ended === undefined || followingQueued.current || busyRef.current) return;
    setBusyState(true);
    try {
      await watchQueuedRuns(ended);
    } catch (error) {
      attention.runEnded({ kind: 'error', reason: describeFailure(error) });
      if (!exiting.current) reportError(error);
    } finally {
      runIdRef.current = undefined;
      setReconnectingSince(undefined);
      runLeft(store);
      setBusyState(false);
    }
  };

  const sendWhileBusy = (delivery: InboxDelivery): void => {
    const draft = draftOf(editorRef.current);
    if (draft === undefined) return;
    const sent = heldAttachments(attachmentsRef.current, editorRef.current.pastes);
    const held = heldMessageOf(editorRef.current);
    replaceEditor(draft.state);
    setAttachments([]);
    backend.recordHistory(draft.text).catch(reportError);
    const refused = (error: unknown): void => {
      replaceEditor(placeMessages(editorRef.current, [held, heldMessageOf(editorRef.current)]));
      setAttachments([...sent, ...attachmentsRef.current]);
      if (!isInboxFull(error)) {
        reportError(error);
        return;
      }
      setHint(INBOX_FULL_HINT);
      refreshInbox().catch(reportError);
    };
    let cancelled = false;
    const adding = backend.inbox.add(delivery, draft.text, sent.map((attachment) => attachment.image), attachOn && hasMentionToken(draft.text));
    if (delivery === 'queue') {
      pendingQueue.current = {
        arrival: activeKeyArrival.current ?? arrivals.current,
        cancel: () => {
          cancelled = true;
          adding.then(
            async (added) => {
              await backend.inbox.withdraw(added.row.id);
              sentMessages.current.delete(added.row.id);
              await refreshInbox();
            },
            () => undefined,
          ).catch(reportError);
        },
      };
    }
    const accepted = async (): Promise<void> => {
      const added = await adding;
      if (cancelled) return;
      sentMessages.current.set(added.row.id, { message: held, attachments: sent });
      setWaitingMessages(added.pending);
      await resumeQueuedRuns();
    };
    accepted().catch(refused);
  };

  const takeBackWaiting = async (): Promise<void> => {
    const rows = waitingRef.current.toSorted((left, right) => left.seq - right.seq);
    const answers = await Promise.all(rows.map((row) => backend.inbox.withdraw(row.id)));
    const withdrawn = answers.filter((answer) => answer.outcome === 'withdrawn').map((answer) => answer.row);
    const records = withdrawn.map((row) => sentMessages.current.get(row.id) ?? { message: { text: row.text, pastes: [] }, attachments: [] });
    for (const row of answers) sentMessages.current.delete(row.row.id);
    const current = editorRef.current;
    const texts = withdrawn.map((row) => row.text);
    replaceEditor(placeMessages(withHistory(current, texts.reduce(pushHistory, current.history)), [...records.map((record) => record.message), heldMessageOf(current)]));
    setAttachments([...records.flatMap((record) => record.attachments), ...attachmentsRef.current]);
    await refreshInbox();
  };

  type Resubmit = { text: string; options: StartRunOptions; sessionModel: string };

  const showPromptNotes = (): void => {
    const shown = promptNotes.current;
    promptNotes.current = [];
    for (const text of shown) note(text);
  };

  const runStarted = async (prepare: () => { start: () => Promise<RunView>; resubmit: Resubmit | undefined }): Promise<void> => {
    setBusyState(true);
    opSeq.current += 1;
    runSeq.current = opSeq.current;
    cancelPendingRun.current = false;
    disarmExit();
    attention.runEnded(undefined);
    signInFailedRun.current = undefined;
    const { start, resubmit } = prepare();
    try {
      const started = await start();
      if (cancelPendingRun.current) {
        cancelPendingRun.current = false;
        backend.cancel(started.id).catch(reportError);
      }
      if (openedSession.current !== undefined) openedSession.current.hasRun = true;
      runCreated(store, started.id, now());
      await watchRun(started.id, undefined, resubmit);
      await watchQueuedRuns(started.id);
    } catch (error) {
      attention.runEnded({ kind: 'error', reason: describeFailure(error) });
      if (!exiting.current) reportError(error);
    } finally {
      promptNotes.current = [];
      runIdRef.current = undefined;
      setReconnectingSince(undefined);
      runLeft(store);
      setBusyState(false);
    }
  };

  const runPrompt = (text: string, options: StartRunOptions = {}): Promise<void> =>
    runStarted(() => {
      const sent = attachmentsRef.current;
      setAttachments([]);
      promptNotes.current = sent.map((attachment) => `attached ${describeAttachment(attachment.file, attachment.image)}`);
      const runOptions: StartRunOptions = {
        ...options,
        ...(sent.length === 0 ? {} : { images: [...(options.images ?? []), ...sent.map((attachment) => attachment.image)] }),
        ...(attachOn && hasMentionToken(text) ? { attachMentions: true } : {}),
      };
      const runModel = sessionModelRef.current;
      return { start: () => backend.startRun(text, runOptions), resubmit: runModel === undefined ? undefined : { text, options: runOptions, sessionModel: runModel } };
    });

  const runCompaction = (instructions: string | undefined): Promise<void> => runStarted(() => ({ start: () => backend.compact(instructions), resubmit: undefined }));

  const runSlash = async (line: string): Promise<boolean> => {
    const parsed = parseSlash(line);
    if (parsed === undefined) return false;
    const command = slash.find(parsed.name);
    if (command === undefined) {
      note(`unknown command /${parsed.name}; /help lists the commands`);
      return true;
    }
    if (sessionModel === undefined && command.needsSession !== false) {
      note(NEEDS_SESSION_NOTE);
      return true;
    }
    const ran = command.run(parsed.args, {
      mode,
      model: sessionModel,
      effort: sessionEffort,
      outputStyle: sessionOutputStyle,
      shownModel,
      setEffort: applyEffort,
      setOutputStyle: applyOutputStyle,
      found,
      wait: waitFor,
      toast: (text) => view.showToast(text),
      refreshConnection,
      bypassAllowed,
      commands: slash.list(),
      backend,
      info: note,
      startRun: async (task, runOptions) => {
        if (busyRef.current) {
          setHint(taskRunningHint(keys));
          return;
        }
        await runPrompt(task, runOptions);
      },
      compact: runCompaction,
      sessions: { startNew: startNewSession, resume: resumeSession, current: () => openedSession.current?.id, now, columns: () => terminal.state().size.columns },
      exit: () => finish({}),
      background: (label, work) => waitFor(commandPhaseText(label), work, label),
      autoMode: props.autoMode ?? unavailableAutoMode,
      shell: props.shell ?? unavailableShell,
      screen: { current: () => terminal.state().screen, set: switchScreen },
      keys,
      negotiation: terminal.state().negotiation,
      display: {
        theme: () => theme,
        previewTheme: setPreviewedTheme,
        storeTheme: async (chosen, signal) => {
          await tuiSettings.save('theme', chosen, signal);
          setTheme(chosen);
        },
        notify: () => notify,
        storeNotify: async (chosen, signal) => {
          await tuiSettings.save('notify', chosen, signal);
          setNotify(chosen);
        },
        a11y: () => a11y,
        storedA11y: (name) => storedA11y[name],
        storeTui: async (name, value, signal) => {
          await tuiSettings.save(name, value, signal);
          if (name === 'copyOnSelect') setCopyOnSelect(value);
        },
        storeA11y: async (name, value, signal) => {
          await tuiSettings.save(name, value, signal);
          setStoredA11y((before) => ({ ...before, [name]: value }));
        },
        pick: overlayPorts.pick,
      },
      keyBindings: { store: bindings, choose: overlayPorts.choose, captureKey: overlayPorts.captureKey },
      overlays: { choose: overlayPorts.choose, promptText: overlayPorts.promptText, closeScreen: overlayPorts.closeScreen },
      externalEditor,
      clipboard: { selected: selectedText, lastAnswer },
      refusedWhileRunning: refusedWhileWorking,
      status: () => statusLines(statusFacts()),
      setMode: async (chosen) => {
        overlayPorts.closeScreen();
        const session = await runCancellable(() => backend.setMode(chosen));
        setModeState(session.permissionMode);
        view.showToast(modeToastText(session.permissionMode));
        showAutoNotice(session);
      },
      setModel: applyModel,
      showAutoNotice,
    });
    await ran;
    return true;
  };

  const submit = async (text: string, held: HeldMessage = { text, pastes: [] }): Promise<void> => {
    if (text.trim().startsWith('/')) {
      await runSlash(text);
      return;
    }
    if (busyRef.current) {
      setHint(taskRunningHint(keys));
      return;
    }
    if (sessionModel === undefined) {
      note(NO_MODEL_NOTE);
      return;
    }
    if (unconfiguredModel.current) {
      replaceEditor(placeMessages(editorRef.current, [held]));
      await flows.modelPicker(sessionModel);
      if (unconfiguredModel.current || editorRef.current.text !== held.text) return;
      replaceEditor(placeText(editorRef.current, ''));
      await runPrompt(text);
      return;
    }
    await runPrompt(text);
  };

  const submitSafely = (text: string, held: HeldMessage): void => {
    prompts.flow(() => submit(text, held)).catch(reportFlowError);
  };

  const sendInitialPrompt = useEffectEvent((): void => {
    if (initialPromptSent.current) return;
    initialPromptSent.current = true;
    if (adoption !== undefined) return;
    const { initialPrompt, initialImages, initialSkill } = props;
    const send = async (): Promise<void> => {
      if (initialImages !== undefined && initialImages.length > 0) await attach(initialImages);
      if (initialPrompt === undefined) return;
      if (initialSkill === undefined) await submit(initialPrompt);
      else await runPrompt(initialPrompt, { skill: initialSkill });
    };
    prompts.flow(send).catch(reportFlowError);
  });

  const reading = loading !== undefined;
  useEffect(() => {
    if (phase.kind === 'ready' && !reading) sendInitialPrompt();
  }, [phase.kind, reading]);

  const attach = async (files: readonly string[]): Promise<void> => {
    const added: Attachment[] = [];
    for (const file of files) added.push({ file, image: await backend.readImage(file) });
    setAttachments([...attachmentsRef.current, ...added]);
  };

  const selectedText = (): SelectedText | undefined => {
    const { selection, source } = view;
    if (selection === undefined) return undefined;
    const extract = extractSelection(source, selection, COPY_MAX_BYTES);
    return extract.complete ? { kind: 'text', text: extract.text } : { kind: 'too-large', bytes: extract.bytes };
  };

  const lastAnswer = (): string | undefined => {
    for (let index = store.count() - 1; index >= 0; index -= 1) {
      const { entry } = store.at(index);
      if (entry.kind === 'assistant') return entry.text;
    }
    return undefined;
  };

  const cycleMode = (): void => {
    backend
      .setMode(nextMode({ current: mode, bypassAllowed }))
      .then((session) => {
        setModeState(session.permissionMode);
        view.showToast(modeToastText(session.permissionMode));
        showAutoNotice(session);
      }, reportError);
  };


  const unconnected = phase.kind === 'unconnected';
  const beforeConversation = phase.kind === 'trust' || phase.kind === 'welcome';
  const modelsUnread = phase.kind === 'trust';
  const syncBanner = useEffectEvent((): void => {
    if (store.byKey(BANNER_KEY) !== undefined || (sessionModel === undefined && (unconnected || beforeConversation)))
      showBanner(bannerModelIn(phaseRef.current, sessionModel, sessionEffort), notices, figureFits);
  });

  const measured = useEffectEvent((entry: MomongaModelEntry): void => showModel(entry));
  const measurementFailed = useEffectEvent((error: unknown): void => modelUnread(error));
  useEffect(() => {
    if (probe === undefined) return undefined;
    return followMeasurement(
      { read: () => backend.model(), timers },
      probe.retryAfterSeconds,
      (entry) => measured(entry),
      (error) => measurementFailed(error),
      (state) => setMeasuring((before) => (before === undefined ? undefined : { since: before.since, state })),
    );
  }, [probe, backend, timers]);

  const fileLinksFailed = useEffectEvent((error: unknown): void => reportError(error));
  useEffect(() => {
    const watching = new AbortController();
    const watchStore = (watched: TranscriptStore): (() => void) => watchFileLinks(watched, (candidates, signal) => backend.fileLinks(candidates, signal), watching.signal, (error) => fileLinksFailed(error));
    const unwatchMain = watchStore(store);
    const unwatchAgents = agents.watch(watchStore);
    return () => {
      watching.abort();
      unwatchMain();
      unwatchAgents();
    };
  }, [store, backend, agents]);

  const inboxChanged = useEffectEvent((): void => {
    refreshInbox().catch(reportError);
  });
  const inboxStreamLost = useEffectEvent((error: unknown): void => reportError(error));
  const printedJudgements = useRef(new Set<string>());
  const judgementsPrinted = useRef<Promise<void>>(Promise.resolve());
  const printJudgements = useEffectEvent((judgements: readonly MemoryJudgementView[], signal: AbortSignal): Promise<void> => {
    const settled = displaysSettled.current;
    const printed = judgementsPrinted.current.then(() => settled).then(() => printDueJudgements(judgements, signal));
    judgementsPrinted.current = printed.then(
      () => undefined,
      () => undefined,
    );
    return printed.then((memoryIds) => (memoryIds.length === 0 ? undefined : backend.markMemoryJudgementsShown(memoryIds)));
  });
  const printDueJudgements = (judgements: readonly MemoryJudgementView[], signal: AbortSignal): readonly string[] => {
    if (signal.aborted) return [];
    const due = judgements
      .filter((judgement) => !printedJudgements.current.has(judgement.memoryId))
      .map((judgement) => ({ memoryId: judgement.memoryId, level: memoryJudgementLevel(judgement), text: formatMemoryJudgement(judgement, shownModel) }));
    if (due.length === 0) return [];
    for (const line of due) {
      printedJudgements.current.add(line.memoryId);
      append({ kind: 'notice', level: line.level, text: line.text });
    }
    return due.map((line) => line.memoryId);
  };
  useEffect(() => {
    if (followedSession === undefined) return undefined;
    const following = new AbortController();
    const lost = (error: unknown): void => {
      if (!following.signal.aborted) inboxStreamLost(error);
    };
    backend.inbox
      .follow(
        followedSession.id,
        followedSession.after,
        {
          changed: () => inboxChanged(),
          opened: () => {
            backend
              .memoryJudgements(followedSession.cwd)
              .then((judgements) => printJudgements(judgements.filter((judgement) => judgement.owed), following.signal))
              .catch(lost);
          },
          memoryJudged: (memoryId) => {
            backend
              .memoryJudgement(memoryId)
              .then((judgement) => printJudgements(judgement.closed ? [] : [judgement], following.signal))
              .catch(lost);
          },
        },
        following.signal,
      )
      .catch(lost);
    return () => following.abort();
  }, [followedSession, backend]);

  useEffect(
    () =>
      terminal.subscribeScreen((request) => {
        if (request.type === 'notice') warn(request.text);
      }),
    [terminal],
  );

  const imageInput = capabilities?.imageInput === true;

  const slashMenu = useSlashMenu({ text: editor.text, commands: slash.list(), active: phase.kind === 'ready' || phase.kind === 'unconnected', height: rows });
  const shellDraft = editor.shell;
  const atMenu = useAtMenu({
    editor,
    active: phase.kind === 'ready' && !shellDraft,
    attachOn,
    rowsCap: menuRowsCap(rows),
    keys,
    candidates: (signal) => backend.userInput.fileCandidates(signal),
    pause: () => new Promise<void>((resolve) => void timers.setTimeout(resolve, 0)),
    reportError,
  });

  const toggleAttach = async (): Promise<void> => {
    const next = !attachOn;
    await runCancellable((signal) => tuiSettings.save('attachFileMentions', next, signal));
    setAttachOn(next);
  };

  const applyAtAct = (act: AtAct): void => {
    if (act.kind === 'place') replaceEditor(placeCaret(placeText(editorRef.current, act.text), act.cursor));
    else if (act.kind === 'toggle') runFlow(toggleAttach);
  };

  const pasteFromClipboard = async (): Promise<void> => {
    const content = await waitFor(READING_CLIPBOARD, (signal) => backend.userInput.readClipboard(signal));
    if (content.kind === 'unsupported') setHint(NO_CLIPBOARD_PROGRAM_HINT);
    else if (content.kind === 'failed') setHint(clipboardReadMessage(content));
    else if (content.kind === 'text') replaceEditor(insertPaste(editorRef.current, content.text));
    else if (content.kind === 'image' && !imageInput) setHint(NO_IMAGE_INPUT_HINT);
    else if (content.kind === 'image') {
      imageCount.current += 1;
      const label = imageSpanLabel(imageCount.current);
      replaceEditor(insertSpan(editorRef.current, label));
      setAttachments([...attachmentsRef.current, { file: label, image: content.image, label }]);
    }
  };

  const runShell = (): void => {
    const outcome = enterOf(editorRef.current);
    if (outcome.kind === 'blank') return;
    if (outcome.kind === 'newline') {
      replaceEditor(outcome.state);
      return;
    }
    const asked = shellCommandOf(editorRef.current);
    if (asked === undefined) return;
    if (phase.kind === 'starting') {
      setHint(STILL_STARTING_HINT);
      return;
    }
    if (busyRef.current || shellRunning.current) {
      setHint(taskRunningHint(keys));
      return;
    }
    if (sessionModel === undefined) {
      note(NEEDS_SESSION_NOTE);
      return;
    }
    const remembered = shellHistoryText(asked);
    replaceEditor(emptyEditor(pushHistory(editorRef.current.history, remembered)));
    backend.recordHistory(remembered).catch(reportError);
    const running = shellStarted(store, asked, now());
    const command: WaitingPhase = { text: commandPhaseText(shellLabel(asked)), startedAt: now() };
    shellRunning.current = true;
    setCommands((before) => [...before, command]);
    const work = async (signal: AbortSignal): Promise<void> => {
      const stop = (): void => {
        backend.userInput.stopShell().catch(reportError);
      };
      signal.addEventListener('abort', stop, { once: true });
      try {
        const io = { onUnprotected: (reason: string) => showUnprotected(reason), onOutput: (text: string) => shellOutput(store, running, text) };
        shellEnded(store, running, await backend.userInput.shell(asked.command, asked.include, io), now());
      } catch (error) {
        shellFailed(store, running, now());
        throw error;
      } finally {
        signal.removeEventListener('abort', stop);
        shellRunning.current = false;
        setCommands((before) => before.filter((other) => other !== command));
      }
    };
    opSeq.current += 1;
    tasks.run(work, { seq: opSeq.current }).catch(reportError);
  };

  const leaveShell = (): void => replaceEditor(leftShell(editorRef.current));

  const unprotectedShown = useRef(false);
  const showUnprotected = (reason: string): void => {
    if (unprotectedShown.current) return;
    unprotectedShown.current = true;
    note(reason);
  };
  const placeMenuText = (text: string): void => replaceEditor(placeText(editorRef.current, text));

  const invitationShown = prompts.invitation !== undefined && overlay === undefined && !busy && editor.text === '';

  const exitOnSecondPress = (action: ExitAction): void => {
    if (armedExit.current?.action === action) {
      disarmExit();
      finish({});
      return;
    }
    armedExit.current = { action, timer: timers.setTimeout(disarmExit, EXIT_ARM_MS) };
    setHint(exitHint(keys.hintFor(action)));
  };

  const cancelAndArmExit = (action: ExitAction): void => {
    cancelNewest();
    exitOnSecondPress(action);
  };

  useEffect(
    () => () => {
      if (armedExit.current !== undefined) timers.clearTimeout(armedExit.current.timer);
    },
    [timers],
  );

  const searchHistory = async (): Promise<void> => {
    const entries = editorRef.current.history.toReversed();
    if (entries.length === 0) return;
    const chosen = await overlayPorts.pick({ title: HISTORY_SEARCH_TITLE, rows: entries.map((entry) => ({ label: entry.replaceAll('\n', ' ') })), decideOn: 'enter', filter: true });
    const entry = chosen === undefined ? undefined : entries[chosen];
    if (entry !== undefined) replaceEditor(placeText(editorRef.current, entry));
  };

  const editExternally = async (): Promise<void> => {
    const outcome = await externalEditor.edit(expandedText(editorRef.current), 'draft');
    if (outcome.kind === 'unset') setHint(editorUnsetHint(keys));
    else replaceEditor(placeText(editorRef.current, outcome.text));
  };

  const onEnter = (): void => {
    const outcome = enterOf(editorRef.current);
    if (outcome.kind === 'blank') return;
    if (outcome.kind === 'newline') {
      replaceEditor(outcome.state);
      return;
    }
    const command = outcome.text.trim().startsWith('/');
    if (shellRunning.current && !command) {
      setHint(taskRunningHint(keys));
      return;
    }
    if (phase.kind === 'starting') {
      setHint(STILL_STARTING_HINT);
      return;
    }
    if (!command && busyRef.current) {
      const delivery = busyDeliveryOf(keys, 'prompt.submit');
      if (delivery === undefined) setHint(taskRunningHint(keys));
      else sendWhileBusy(delivery);
      return;
    }
    if (!command && sessionModel === undefined) {
      note(NO_MODEL_NOTE);
      return;
    }
    setAttachments(heldAttachments(attachmentsRef.current, editorRef.current.pastes));
    const held = heldMessageOf(editorRef.current);
    replaceEditor(outcome.state);
    backend.recordHistory(outcome.text).catch(reportError);
    submitSafely(outcome.text, held);
  };

  const chooseRow = (target: ViewTarget | undefined): void => {
    listFocusRef.current = target;
    setListFocus(target);
  };

  const listRows = (): readonly ViewTarget[] => listTargetsRef.current;

  const openView = (target: ViewTarget): void => {
    agentsRef.current.open(target.kind === 'main' ? undefined : target.runId);
    chooseRow(undefined);
  };

  const onListKey = (event: KeyEvent, pressed: KeyTable): void => {
    const rowsShown = listRows();
    const chosen = chosenIndexOf(rowsShown, listFocusRef.current);
    const listAction = pressed.actionOf(AGENT_LIST_CONTEXTS, event);
    const rowAt = (index: number): ViewTarget => {
      const target = rowsShown[index];
      if (target === undefined) throw new Error(`the list of views has no row ${index}`);
      return target;
    };
    if (listAction === 'agents.next') chooseRow(rowAt(Math.min(chosen + 1, rowsShown.length - 1)));
    else if (listAction === 'agents.previous') chooseRow(chosen === 0 ? undefined : rowAt(chosen - 1));
    else if (listAction === 'agents.open') {
      if (listSeen.current.drawn) openView(rowAt(chosen));
    }
    else if (pressed.actionOf(EDITOR_CONTEXTS, event) === 'run.stop') chooseRow(undefined);
    else {
      chooseRow(undefined);
      routeKey(keyRouteOf(routeFacts()), event, pressed);
    }
  };

  const onEditorAction = (action: ActionId | undefined, typed: string | undefined): void => {
    const starting = phase.kind === 'starting';
    const working = (busyRef.current && !betweenRuns.current) || tasks.active() || commands.length > 0;
    const current = editorRef.current;
    if (action === 'prompt.submit') onEnter();
    else if (action === 'prompt.queue' || action === 'prompt.steer') {
      const delivery = busyDeliveryOf(keys, action);
      if (busyRef.current && delivery !== undefined) sendWhileBusy(delivery);
    } else if (action === 'editor.up' && waitingRef.current.length > 0 && onFirstLine(current)) runFlow(takeBackWaiting);
    else if (action === 'transcript.detail') {
      if (!starting) toolView.showNewest();
    } else if (action === 'run.stop') {
      const keyArrival = activeKeyArrival.current ?? arrivals.current;
      if (pendingQueue.current?.arrival === keyArrival || working) cancelNewest();
      else if (invitationShown) prompts.dismissInvitation();
    } else if (action === 'prompt.interrupt') {
      if (starting) finish({});
      else if (armedExit.current?.action === action) exitOnSecondPress(action);
      else if (working) cancelAndArmExit(action);
      else if (current.text === '') exitOnSecondPress(action);
      else replaceEditor(emptyEditor(current.history));
    } else if (action === 'prompt.exit') {
      if (current.text !== '') replaceEditor(applyAction(current, 'editor.deleteAfter'));
      else if (!starting) exitOnSecondPress(action);
    } else if (action === 'history.search') runFlow(searchHistory);
    else if (action === 'editor.external') runFlow(editExternally);
    else if (action === 'screen.repaint') writeThroughInk('');
    else if (action === 'prompt.pasteImage') runFlow(pasteFromClipboard);
    else if (action === 'editor.deleteBefore' && current.text === '' && attachmentsRef.current.length > 0) setAttachments(attachmentsRef.current.slice(0, -1));
    else if (action === 'editor.down' && current.text === '' && applyAction(current, action) === current && listRows().length > 0) chooseRow({ kind: 'main' });
    else if (isEditorAction(action)) replaceEditor(applyAction(current, action));
    else if (action === undefined && typed !== undefined) replaceEditor(typedIntoDraft(current, typed));
  };

  const routeFacts = (): KeyRouteFacts => ({
    trust: phase.kind === 'trust',
    toolView: toolView.shown,
    overlay: prompts.overlayKind(),
    welcome: phase.kind === 'welcome',
    prompt: prompts.promptStage(),
    detail: prompts.detailShown(panelFacts),
    shellDraft: editorRef.current.shell,
    menuOpen: slashMenu.isOpen(editorRef.current.text) || atMenu.open,
    agentsChosen: listFocusRef.current !== undefined && listRows().length > 0,
    fullscreen,
  });

  const onDraftKey = (route: 'shell' | 'menu' | 'editor', event: KeyEvent, pressed: KeyTable, action: ActionId | undefined, typed: string | undefined): void => {
    if (route === 'shell') {
      const shellAction = pressed.actionOf(SHELL_CONTEXTS, event);
      if (shellAction === 'shell.run') runShell();
      else if (shellAction === 'shell.leave' || (action === 'editor.deleteBefore' && editorRef.current.text === '')) leaveShell();
      else if (action !== 'prompt.submit' && action !== 'prompt.queue' && action !== 'prompt.steer') onEditorAction(action, typed);
      return;
    }
    if (route === 'menu') {
      const menuAction = pressed.actionOf(MENU_CONTEXTS, event);
      const atAct = isMenuAction(menuAction) ? atMenu.act(editorRef.current, menuAction) : undefined;
      if (atAct !== undefined) {
        applyAtAct(atAct);
        return;
      }
      const menuAct = isMenuAction(menuAction) ? slashMenu.act(editorRef.current.text, menuAction) : undefined;
      if (menuAct?.kind === 'handled') return;
      if (menuAct !== undefined) placeMenuText(menuAct.text);
      if (menuAct?.kind === 'complete') return;
    }
    onEditorAction(action, typed);
  };

  const routeKey = (route: KeyRoute, event: KeyEvent, pressed: KeyTable): void => {
    const action = pressed.actionOf(EDITOR_CONTEXTS, event);
    const typed = pressed.typedOf(event);
    switch (route) {
      case 'trust':
        if (phase.kind === 'trust') prompts.trustKey(phase.path, event, pressed);
        return;
      case 'tool-view':
        if (!toolView.key(event, pressed)) routeKey(keyRouteOf({ ...routeFacts(), toolView: false }), event, pressed);
        return;
      case 'overlay':
        prompts.overlayKey(event, pressed);
        return;
      case 'welcome':
        return;
      case 'agents':
        onListKey(event, pressed);
        return;
      case 'prompt':
      case 'shell':
      case 'menu':
      case 'editor':
        if (typed !== undefined) {
          typedRef.current = true;
          prompts.dismissInvitation();
        }
        if (action === 'mode.cycle') {
          if (sessionModel !== undefined) cycleMode();
        } else if (route === 'prompt') prompts.runPromptKey(event, pressed);
        else onDraftKey(route, event, pressed, action, typed);
    }
  };

  const screenNow = (): string => {
    if (toolView.shown) return TOOL_VIEW_SCREEN;
    const base = prompts.screenId(phase.kind === 'trust');
    if (base !== 'prompt') return base;
    if (phase.kind === 'starting') return 'starting';
    if (phase.kind === 'welcome') return 'welcome';
    return base;
  };

  const judgedScreen = (): string | undefined => (arrivals.current > 0 ? arrivedScreen.current : drawnScreen.current);

  const isLaunchScreen = (): boolean => drawnScreen.current === undefined || judgedScreen() === 'starting' || judgedScreen() === 'welcome';

  const followsAnswer = (event: KeyEvent): boolean => {
    const mark = answerMark.current;
    if (!isPlainKey(event, 'escape') || mark === undefined) return false;
    return mark.sync || (arrivals.current > 0 && mark.arrival === arrivals.current);
  };

  const markAnswer = (event: KeyEvent, pressed: KeyTable, arrival: number): void => {
    if (!isPlainKey(event, 'escape') && !isPlainKey(event, 'enter') && pressed.actionOf(EDITOR_CONTEXTS, event) !== 'prompt.queue' && prompts.overlayKind() !== 'kept') return;
    const mark = { arrival, sync: true };
    answerMark.current = mark;
    queueMicrotask(() => {
      mark.sync = false;
    });
  };

  const withKeyArrival = (arrival: number, work: () => void): void => {
    const previous = activeKeyArrival.current;
    activeKeyArrival.current = arrival;
    try {
      work();
    } finally {
      activeKeyArrival.current = previous;
    }
  };

  const deliverEsc = (event: KeyEvent, pressed: KeyTable, arrival: number): void => {
    withKeyArrival(arrival, () => {
      if (screenNow() !== judgedScreen() && (isLaunchScreen() || prompts.isProductPanel(phase.kind === 'trust'))) {
        prompts.undrawnKey(event, pressed);
        return;
      }
      actOnKey(event, pressed);
    });
  };

  const onImmediateKey = (event: KeyEvent, pressed: KeyTable, arrival: number): void => {
    withKeyArrival(arrival, () => {
      if (screenNow() !== judgedScreen()) {
        if (isPlainKey(event, 'escape') && !isLaunchScreen() && !prompts.isProductPanel(phase.kind === 'trust')) {
          actOnKey(event, pressed);
          markAnswer(event, pressed, arrival);
          return;
        }
        prompts.undrawnKey(event, pressed);
        return;
      }
      actOnKey(event, pressed);
      markAnswer(event, pressed, arrival);
    });
  };

  const deliverFollowing = useEffectEvent((item: { readonly event: KeyEvent; readonly pressed: KeyTable; readonly arrival: number }): void => {
    if (isPlainKey(item.event, 'escape')) deliverEsc(item.event, item.pressed, item.arrival);
    else onImmediateKey(item.event, item.pressed, item.arrival);
  });

  const drainFollowingKeys = (): void => {
    if (drainingKeys.current) return;
    drainingKeys.current = true;
    const step = (): void => {
      if (unmounted.current) {
        drainingKeys.current = false;
        return;
      }
      const next = followingKeys.current.shift();
      if (next === undefined) {
        drainingKeys.current = false;
        return;
      }
      deliverFollowing(next);
      if (followingKeys.current.length > 0) void waitUntilRenderFlush().then(step);
      else drainingKeys.current = false;
    };
    void waitUntilRenderFlush().then(step);
  };

  const onKey = (event: KeyEvent, pressed: KeyTable): void => {
    const arrival = arrivals.current;
    if (pendingQueue.current !== undefined && pendingQueue.current.arrival !== arrival && !drainingKeys.current && followingKeys.current.length === 0) {
      pendingQueue.current = undefined;
    }
    if (drainingKeys.current || followsAnswer(event)) {
      followingKeys.current.push({ event, pressed, arrival });
      drainFollowingKeys();
      return;
    }
    onImmediateKey(event, pressed, arrival);
  };

  const actOnKey = (event: KeyEvent, pressed: KeyTable): void => {
    bindings.poll(now());
    const action = pressed.actionOf(EDITOR_CONTEXTS, event);
    const route = keyRouteOf(routeFacts());
    const interrupts = route === 'prompt' && (action === 'prompt.interrupt' || pressed.actionOf(SELECT_CONTEXTS, event, 'plain') === 'select.interrupt');
    if (interrupts && armedExit.current?.action === 'prompt.interrupt') {
      exitOnSecondPress('prompt.interrupt');
      return;
    }
    if (armedExit.current === undefined || armedExit.current.action !== action) {
      disarmExit();
      setHint(undefined);
    }
    routeKey(route, event, pressed);
  };

  const onPaste = (text: string): void => {
    if (screenNow() !== drawnScreen.current) {
      prompts.undrawnPaste(text);
      return;
    }
    if (prompts.paste(text)) return;
    if (phase.kind === 'trust' || phase.kind === 'welcome' || overlay !== undefined || promptTakesFocus(transcript)) return;
    disarmExit();
    setHint(undefined);
    const paths = imageInput ? pastedImagePaths(text) : undefined;
    if (paths !== undefined) {
      attach(paths).catch(reportError);
      return;
    }
    replaceEditor(insertPaste(editorRef.current, text));
  };

  const onTyped = useEffectEvent((event: TerminalEvent): boolean => {
    move?.probe();
    if (event.type === 'paste') onPaste(event.text);
    else if (event.type === 'key') onKey(event, keys);
    return event.type === 'paste' || event.type === 'key';
  });

  useEffect(() => terminal.input.claim('typing', (event) => onTyped(event)), [terminal]);

  const servedMember = model?.chain.find((member) => member.model === servedTarget);
  const servedPlan = servedMember?.billing === 'plan' ? servedMember.plan : undefined;
  const servedProfile = servedPlan === undefined ? undefined : profiles.find((profile) => profile.id === servedPlan.profile);
  const planRow = phase.kind !== 'ready' || servedProfile === undefined ? undefined : `${sessionModel === undefined ? '' : (displays.get(sessionModel) ?? sessionModel)} · ${servedProfile.messages.planInUseLabel} · ${servedProfile.messages.manageUsageLabel}: ${servedProfile.usageUrl}`;
  const fullscreen = terminalState.screen === 'fullscreen';
  const panelFacts = { trustPath: phase.kind === 'trust' ? phase.path : undefined, ready: phase.kind === 'ready' };
  const panel = prompts.panel(panelFacts);
  const conversationArea = !beforeConversation;
  const inputShown = conversationArea && panel === undefined;
  const completionOpen = slashMenu.open || atMenu.open;
  const menuShown = inputShown && (invitationShown || completionOpen);
  const shownAttachments = heldAttachments(attachments, editor.pastes);
  const waitingLines = inputShown ? waitingRows(waitingMessages, columns) : [];
  const keptDraft = !inputShown && panel !== undefined ? keptDraftLine(editor.text) : undefined;
  const busyHintRow = !inputShown || phase.kind !== 'ready' ? undefined : shellDraft ? shellHint(keys) : !busy ? undefined : slashMenu.open || atMenu.open ? completionHint(keys) : busyHint(keys, waitingMessages.length > 0);
  const invitationInMenu = menuShown && phase.kind === 'ready' && invitationShown;
  const invitationText = invitationInMenu && prompts.invitation !== undefined ? invitationRows(prompts.invitation, keys, columns) : [];
  const waiting = waitingOf({
    startingSince: phase.kind === 'starting' ? openedAt : undefined,
    prompting: blockingPrompt(transcript),
    reconnectingSince: phase.kind === 'ready' ? reconnectingSince : undefined,
    run: phase.kind === 'ready' ? shownRunPhase(transcript) : undefined,
    command: commands.at(-1),
    measuring: phase.kind === 'ready' ? measuring : undefined,
    panelOwnsEscape: overlay !== undefined,
    loading: phase.kind === 'ready' ? loading : undefined,
  });
  const listBase = { subagents: transcript.subagents, shown: shownAgent?.runId, keys, screenReader: a11y.screenReader, columns };
  const awaitingApproval = transcript.subagents.some((subagent) => subagent.runId === shownAgent?.runId && subagent.awaitingApproval);
  const headerText =
    shownAgent === undefined
      ? undefined
      : agentHeader(
          {
            agent: shownAgent.agent,
            state: shownAgent.loading !== undefined ? loadingText(shownAgent.loading.applied, shownAgent.loading.backlog) : shownAgent.end !== undefined ? endStateOf(shownAgent.end) : awaitingApproval ? 'waiting for approval' : 'running',
            model: shownModel(viewed.state().answeringTarget ?? shownAgent.model),
            effort: shownEffort(entriesRef.current, shownAgent.model, shownAgent.effort, viewed.state().answeringTarget),
          },
          columns,
        );
  const rowRequests: RowRequests = {
    header: headerText === undefined ? 0 : 1,
    waiting: waiting === undefined || a11y.screenReader ? 0 : 1,
    inputRows: inputRowsOf(editor, columns),
    invitation: invitationText.length,
    menu: !menuShown || invitationInMenu ? 0 : atMenu.open ? atMenu.rows : slashMenu.rows,
    subagents: agentListRequest({ ...listBase, focus: listFocus === undefined ? undefined : 0 }),
    footerSecond: (!fullscreen || planRowFits(planRow, columns) ? (planRow === undefined ? 0 : 1) : 0) + (busyHintRow === undefined ? 0 : 1),
    lines: inputShown ? shownAttachments.length + waitingLines.length : keptDraft === undefined ? 0 : 1,
    panel: panel === undefined ? undefined : (panelRows ?? 0),
  };
  const allocation = allocate(rows, rowRequests);
  const listFacts = { ...listBase, rows: fullscreen ? allocation.subagents : rowRequests.subagents };
  const listTargets = agentListDrawn(transcript.subagents, shownAgent?.runId) ? viewTargetsOf(transcript.subagents) : [];
  const listRowsKey = listTargets.map((target) => (target.kind === 'main' ? 'main' : target.runId)).join(' ');
  if (listSeen.current.rows !== listRowsKey) listSeen.current = { rows: listRowsKey, drawn: false };
  const shownFocus = listFocus === undefined || listTargets.length === 0 ? undefined : chosenIndexOf(listTargets, listFocus);
  const listLines = agentListLines({ ...listFacts, focus: shownFocus, now: 0 });
  const agentFeed = useMemo(() => createHistoryFeed(), [shownAgent, historyGeneration]);
  const shownFeed = shownAgent === undefined ? feed : agentFeed;
  const transcriptAllocation = panel === undefined ? allocation : allocate(rows, { ...rowRequests, panel: 0 });
  const transcriptWidth = fullscreen ? Math.max(1, columns - SCROLLBAR_COLUMNS) : columns;
  const onlyEntry = visible.count() === 1 ? visible.at(0).entry : undefined;
  const followedStart = panel !== undefined && (phase.kind === 'starting' || beforeConversation) && onlyEntry?.kind === 'banner' ? onlyEntry.banner : undefined;
  const listFollows = followedStart !== undefined;
  const figureFits = followedStart === undefined ? conversationArea : panelRows !== undefined && bannerRows({ ...followedStart, figure: true }, transcriptWidth).length <= allocation.viewport;
  useEffect(() => {
    syncBanner();
  }, [sessionModel, sessionEffort, entriesVersion, notices, unconnected, beforeConversation, modelsUnread, displays, figureFits]);
  const tailPose = useTailWag(!a11y.reducedMotion && !a11y.screenReader && props.reopen === undefined && props.adoption === undefined && loading === undefined && onlyEntry?.kind === 'banner' && figureDrawn(onlyEntry.banner, transcriptWidth), timers);
  const busyHintRows = busyHintRow === undefined || (fullscreen && allocation.footer < 2) ? 0 : 1;
  const view = useTranscriptView({
    store: viewed,
    terminal,
    fullscreen: fullscreen && !switching,
    width: transcriptWidth,
    allocation,
    viewport: transcriptAllocation.viewport,
    copyOnSelect,
    now,
    copy: (text) => backend.copyToClipboard(text),
    openLink: ({ kind, url }) => {
      const onFailure = (message: string): void => reportError(new Error(message));
      if (kind === 'file') backend.openFile(url, untilNextKey(terminal.input), onFailure);
      else backend.openUrl(url, untilNextKey(terminal.input), onFailure);
    },
    reportError,
    keyFacts: () => ({ panelOpen: panel !== undefined || toolView.shown, menuOpen: slashMenu.isOpen(editorRef.current.text) || atMenu.open, inputEmpty: editorRef.current.text === '' }),
    keys,
    a11y,
    timers,
  });
  const followRows = listFollows ? drawnTranscriptRows(allocation.viewport, view.window.rows.length) : undefined;
  const pointerAllocation = followRows === undefined ? allocation : { ...allocation, viewport: followRows };
  const toolView = useToolView({
    store: viewedLive,
    terminal,
    now,
    timers,
    keys,
    a11y,
    frame: { width: transcriptWidth, rows: fullscreen ? allocation.viewport : panelRowsCap(rows), border: false },
    yielded: panel !== undefined || switching,
    window: fullscreen && !switching ? view.window : undefined,
    allocation,
    readStoredResult: (stored, offset) => backend.toolResult(stored.runId, stored.callId, offset),
    reportError,
  });
  usePromptPointer({
    terminal,
    active: fullscreen && !switching,
    allocation: pointerAllocation,
    panelOpen: panel !== undefined,
    menuOpen: inputShown && completionOpen,
    panelPress: (row) => {
      if (screenNow() === drawnScreen.current) prompts.press(panelFacts, row);
    },
    panelWheel: (wheelRows) => prompts.wheel(panelFacts, wheelRows),
    menuPress: (row) => {
      if (atMenu.open) {
        const atAct = atMenu.press(editorRef.current, row);
        if (atAct !== undefined) applyAtAct(atAct);
        return;
      }
      const act = slashMenu.press(row, allocation.menu);
      if (act?.kind === 'complete') placeMenuText(act.text);
    },
    menuWheel: (wheelRows) => slashMenu.wheel(wheelRows),
  });
  const onInputPress = useEffectEvent((event: TerminalEvent): boolean => {
    if (!fullscreen || switching || panel !== undefined || !inputShown) return false;
    if (event.type !== 'mouse' || event.kind !== 'press' || event.button !== 'left') return false;
    const hit = regionAt(allocation, event.row);
    if (hit?.region !== 'input') return false;
    const offset = inputOffsetAt(editor, columns, inputContentRows(allocation.input), hit.row, event.col);
    if (offset !== undefined) replaceEditor(placeCaret(editorRef.current, offset));
    return true;
  });
  useEffect(() => terminal.input.claim('input-caret', (event) => onInputPress(event)), [terminal]);
  const listTargetAt = (screenRow: number): ViewTarget | undefined => {
    const hit = regionAt(allocation, screenRow);
    return hit?.region === 'subagents' ? listLines[hit.row]?.target : undefined;
  };
  const onListPointer = useEffectEvent((event: TerminalEvent): boolean => {
    if (!fullscreen || switching || toolView.shown || event.type !== 'mouse' || event.button !== 'left') return false;
    const pressed = listPress.current;
    if (event.kind === 'press') {
      listPress.current = listTargetAt(event.row) === undefined ? undefined : { row: event.row, col: event.col };
      return listPress.current !== undefined;
    }
    if (pressed === undefined) return false;
    if (event.kind === 'move') {
      if (event.row !== pressed.row || event.col !== pressed.col) listPress.current = undefined;
      return true;
    }
    if (event.kind !== 'release') return false;
    listPress.current = undefined;
    const target = event.row === pressed.row && event.col === pressed.col ? listTargetAt(event.row) : undefined;
    if (target !== undefined) openView(target);
    return true;
  });
  useEffect(() => terminal.input.claim('agent-list', (event) => onListPointer(event)), [terminal]);
  const screenOfHover = `${terminalState.screen} ${columns}x${rows}`;
  const drawnHoverAt = (event: MouseEvent): Pointed | undefined => {
    const listed = regionAt(allocation, event.row);
    if (listed !== undefined && listTargetAt(event.row) !== undefined) return { place: 'agents', row: listed.row, range: undefined };
    const shown = view.hoverAt(event);
    if (shown !== undefined) return { place: 'viewport', row: shown.row, range: shown.range };
    const expand = regionAt(allocation, event.row);
    return expand?.region === 'viewport' && toolView.expandsAt(event.row) ? { place: 'viewport', row: expand.row, range: undefined } : undefined;
  };
  const hoverAt = (event: MouseEvent): Pointed | undefined => {
    if (!fullscreen || switching || toolView.shown) return undefined;
    const pointed = regionAt(pointerAllocation, event.row);
    if (pointed?.region === 'input' && panel !== undefined) return prompts.hover(panelFacts, pointed.row) ? { place: 'panel', row: pointed.row, range: undefined } : undefined;
    if (pointed?.region === 'menu' && inputShown && completionOpen) return (atMenu.open ? atMenu.hover(editorRef.current, pointed.row) : slashMenu.hover(pointed.row, allocation.menu)) ? { place: 'menu', row: pointed.row, range: undefined } : undefined;
    const target = listTargetAt(event.row);
    const chosen = listFocusRef.current;
    const sameRow = chosen !== undefined && target !== undefined && (chosen.kind === 'main' ? target.kind === 'main' : target.kind === 'agent' && target.runId === chosen.runId);
    if (target !== undefined && !sameRow && keyRouteOf(routeFacts()) === 'agents') chooseRow(target);
    return drawnHoverAt(event);
  };
  const keepHover = (next: Hovered | undefined): void => {
    const before = hoveredRef.current;
    if (before?.place === next?.place && before?.row === next?.row && before?.range?.[0] === next?.range?.[0] && before?.range?.[1] === next?.range?.[1] && before?.screen === next?.screen) return;
    hoveredRef.current = next;
    setHovered(next);
  };
  const onPointer = useEffectEvent((event: TerminalEvent): void => {
    if (event.type === 'focus' && event.direction === 'out') keepHover(undefined);
    if (event.type !== 'mouse' || event.kind !== 'move' || event.button !== 'none') return;
    const at = hoverAt(event);
    keepHover(at === undefined ? undefined : { ...at, screen: screenOfHover, at: event });
  });
  useEffect(() => terminal.input.observe((event) => onPointer(event)), [terminal]);
  const shownHover = hovered !== undefined && hovered.screen === screenOfHover && fullscreen && !switching && !toolView.shown ? drawnHoverAt(hovered.at) : undefined;
  const onChord = useEffectEvent((event: TerminalEvent): boolean => {
    if (event.type !== 'key') return false;
    const step = keys.chordStep(chordContextsOf(routeFacts()), chord.current, event);
    chord.current = step.kind === 'pending' ? step.prefix : undefined;
    if (step.kind === 'none') return false;
    if (step.kind === 'action' && !view.act(step.id)) onKey(event, chordPressOf(keys, step.id));
    return true;
  });
  useEffect(() => terminal.input.claim('chord', (event) => onChord(event)), [terminal]);
  useEffect(
    () =>
      terminal.input.observeArrivals?.(() => {
        arrivals.current += 1;
        arrivedScreen.current = drawnScreen.current;
      }),
    [terminal],
  );
  if (frameWatch.current?.terminal !== terminal) {
    frameWatch.current?.stop();
    frameWatch.current = {
      terminal,
      stop: terminal.input.observeFrames(() => {
        drawnScreen.current = renderedScreen.current;
        if (listSeen.current.rows !== '') listSeen.current.drawn = true;
      }),
    };
  }
  useEffect(
    () => () => {
      unmounted.current = true;
      frameWatch.current?.stop();
      frameWatch.current = undefined;
      followingKeys.current = [];
      drainingKeys.current = false;
    },
    [],
  );
  useEffect(() => {
    facts.current = { overlay: overlay !== undefined, position: shownAgent === undefined ? view.position : FOLLOWING, tasks, terminal, flush: waitUntilRenderFlush };
    feedRef.current = feed;
    listTargetsRef.current = listTargets;
    sourceRef.current = shownAgent === undefined ? view.source : undefined;
    move?.check();
  });
  useEffect(() => move?.attach(handover.surface), [move, handover]);
  useEffect(() => tasks.subscribe(() => move?.check()), [tasks, move]);
  const pollKeyFile = useEffectEvent((): void => bindings.poll(now()));
  const keepHistory = useEffectEvent((): void => {
    if (a11y.screenReader && terminalState.screen === 'fullscreen') switchScreen('scrollback').catch(reportError);
  });
  useEffect(() => {
    keepHistory();
  }, [a11y.screenReader, terminalState.screen]);
  const footerModel = (): FooterModel | undefined => {
    if (sessionModel === undefined) return undefined;
    const shown = shownEffort(entriesRef.current, sessionModel, sessionEffort);
    const name = shownModel(sessionModel);
    return shown?.kind === 'sent' ? { name, effort: effortLine(shown, 'short') } : { name };
  };
  const statusFacts = (): StatusFacts => {
    const percent = contextPercentOf(transcript.contextTokens, capabilities?.contextWindow);
    const model = footerModel();
    return { mode, tokens: formatTokens(sessionTokens(transcript)), context: percent === undefined ? 'unknown' : `${percent}%`, ...(model?.effort === undefined ? {} : { model: modelWithEffort(model.name, model.effort) }) };
  };
  const say = useEffectEvent((text: string | undefined): void => {
    if (a11y.screenReader && text !== undefined) note(text);
  });
  const waitingText = waiting?.phase.text;
  useEffect(() => {
    say(waitingText);
  }, [waitingText, a11y.screenReader]);
  const sayStatus = useEffectEvent((): void => {
    if (phase.kind === 'ready') say(statusLine(statusFacts()));
  });
  useEffect(() => {
    sayStatus();
  }, [mode, phase.kind, a11y.screenReader]);
  const shownHint = hint ?? view.toast;
  useEffect(() => {
    say(shownHint);
  }, [shownHint]);
  useEffect(() => {
    say(planRow);
  }, [planRow]);
  const thoughtWindow = thoughtWindowOf(allocation.viewport);
  useEffect(() => {
    setThoughtWindow(store, thoughtWindow);
    if (viewedLive !== store) setThoughtWindow(viewedLive, thoughtWindow);
  }, [store, viewedLive, thoughtWindow]);
  const footerOverlay = overlay?.kind === 'kept' ? overlay.shown : overlay;
  const panelModel = footerOverlay?.kind === 'pick' && footerOverlay.request.showModelInFooter === true && !a11y.screenReader ? footerModel() : undefined;
  const footerFacts =
    phase.kind === 'ready' && overlay === undefined && !a11y.screenReader
      ? {
          mode,
          tokens: sessionTokens(transcript),
          contextPercent: contextPercentOf(transcript.contextTokens, capabilities?.contextWindow),
          imageInput,
          answer: shownHint,
          newline: newlineHintText(newlineKeyHint(keys, terminalState.negotiation)),
          ...modelFactOf(footerModel()),
        }
      : undefined;

  renderedScreen.current = screenNow();
  return (
    <TailPoseContext value={tailPose}>
      <Screen
        view={switching || erased || terminalState.tooSmall ? 'blank' : terminalState.screen}
        columns={columns}
        rows={rows}
        allocation={allocation}
        panel={panel ?? (fullscreen || !toolView.shown ? undefined : toolView.view)}
        panelFollows={followRows}
        onPanelRows={setPanelRows}
        regions={{
          header:
            headerText === undefined ? null : (
              <Text bold wrap="truncate">
                {escapeTerminalLine(headerText)}
              </Text>
            ),
          transcript: fullscreen && toolView.shown ? (
            toolView.view
          ) : fullscreen ? (
            <TranscriptView window={view.window} height={panel === undefined ? allocation.viewport : followRows ?? drawnTranscriptRows(transcriptAllocation.viewport, view.window.rows.length)} width={transcriptWidth} entries={viewed.count()} following={view.position.following} selection={view.selection} hovered={shownHover?.place === 'viewport' ? shownHover : undefined} />
          ) : (
            <HistoryView key={`${historyGeneration}:${shownAgent?.runId ?? ''}`} store={viewed} source={view.source} feed={shownFeed} ready={scrollbackReady} timers={timers} columns={transcriptWidth} />
          ),
          menu: !menuShown ? null : invitationText.length > 0 ? <InvitationLine rows={fullscreen ? invitationText.slice(0, allocation.menu) : invitationText} /> : atMenu.open ? <AtList labels={atMenu.labels} index={atMenu.index} /> : slashMenu.view(fullscreen ? allocation.menu : slashMenu.rows),
          waiting: waiting === undefined || a11y.screenReader ? null : <WaitingRow waiting={waiting} now={now} timers={timers} keys={keys} reducedMotion={a11y.reducedMotion} onTick={pollKeyFile} />,
          lines: inputShown ? (
            <>
              <AttachmentLines attachments={shownAttachments} keys={keys} />
              {waitingLines.map((line, index) => (
                <Text key={index} dimColor wrap="truncate">
                  {line}
                </Text>
              ))}
            </>
          ) : keptDraft === undefined ? null : (
            <Text dimColor wrap="truncate">
              {keptDraft}
            </Text>
          ),
          input: inputShown ? <InputBox editor={editor} mark={shellDraft ? SHELL_MARK : CHAT_MARK} columns={columns} framed={!a11y.screenReader} rows={fullscreen ? inputContentRows(allocation.input) : undefined} top={inputTopOf(fullscreen ? allocation : naturalRows(shownFeed.live(view.source, viewed.settledAt).length, rowRequests))} /> : null,
          footer: (
            <>
              <Footer facts={footerFacts} panelModel={panelModel} hint={a11y.screenReader ? undefined : hint} unconnected={phase.kind === 'unconnected'} planRow={a11y.screenReader ? undefined : planRow} width={columns} rows={fullscreen ? allocation.footer - busyHintRows : 2} keys={keys} />
              {busyHintRow === undefined || busyHintRows === 0 ? null : (
                <Text dimColor wrap="truncate">
                  {busyHintRow}
                </Text>
              )}
            </>
          ),
          subagents: <AgentList {...listFacts} focus={shownFocus} now={now} timers={timers} hovered={shownHover?.place === 'agents' ? shownHover.row : undefined} />,
        }}
      />
    </TailPoseContext>
  );
}
