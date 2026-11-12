import { askTrustItems } from './project-items.ts';
import { askProjectCheck } from './project-check.ts';
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Text, useApp, useStdout } from 'ink';
import { PLAN_NOT_ELIGIBLE_CODE, PLAN_USE_NOT_ENABLED_CODE, SIGN_IN_REQUIRED_CODE, USAGE_LIMIT_CODES, USAGE_PAUSED_CODE, agentReadiness, autoModeNotice, displayMapOf, isNotListedCapabilities, isOpaqueEvent, messageOf, PLAN_DISABLED_STATE } from '@momonga/protocol';
import type { ChainCapabilities, ImageAttachment, InboxDelivery, Measuring, InboxRowView, MomongaModelEntry, PermissionMode, PlanAccountRef, PlanAccountsResponse, PlanProfileView } from '@momonga/protocol';
import { listingViewsOf } from '../client/gateway-client.ts';
import type { RunView, SessionView } from '../client/views.ts';
import { describeAttachment, pastedImagePaths } from '../images.ts';
import { describeFailure } from '../failure.ts';
import { followMeasurement, readinessNoticeOf } from '../readiness.ts';
import { isTerminalStatus } from '../run/follow.ts';
import { describeRunEnd } from '../run/headless.ts';
import type { Reopen } from '../run/resolve-session.ts';
import { accountsOf, profileOf } from '../plan/accounts.ts';
import type { StartRunOptions, TuiBackend } from './backend.ts';
import { createBackgroundTasks } from './background-tasks.ts';
import type { BackgroundTasks } from './background-tasks.ts';
import { autoNoticeDue } from './notices.ts';
import type { AutoNoticePair } from './notices.ts';
import { DEFAULT_SLASH_COMMANDS } from './commands/index.ts';
import { modelPickerCommand, planSlashCommands } from './commands/auth.ts';
import { createFoundServers } from './models/context.ts';
import { notConfiguredAnyMoreText } from './models/texts.ts';
import { createPlanFlows } from './plan-flows.ts';
import type { PlanFlows } from './plan-flows.ts';
import type { StartupBanner, StartupConfig } from './startup.tsx';
import { pickConversation } from './commands/resume.ts';
import { skillCommands } from './commands/skills.ts';
import { createReplayQueue } from './replay.ts';
import type { ReplayQueue } from './replay.ts';
import { applyAction, emptyEditor, enterOf, expandedText, insertPaste, insertSpan, insertText, isEditorAction, placeCaret, placeText, pushHistory, withHistory } from './editor.ts';
import { hasMentionToken, imageSpanLabel, NO_CLIPBOARD_PROGRAM_HINT, NO_IMAGE_INPUT_HINT, useAtMenu } from './attach.ts';
import type { AtAct } from './attach.ts';
import { leftShell, SHELL_MARK, shellCommandOf, shellEnded, shellFailed, shellHint, shellHistoryText, shellLabel, shellOutput, shellStarted, showShellRecord, typedIntoDraft } from './user-shell.ts';
import { INBOX_FULL_HINT, busyDeliveryOf, busyHint, completionHint, draftOf, isInboxFull, onFirstLine, takenBack, waitingRows } from './busy-input.ts';
import type { EditorState } from './editor.ts';
import { editorUnsetHint } from './external-editor.ts';
import type { ExternalEditorPort } from './external-editor.ts';
import { fixedKeyBindings } from './keys/store.ts';
import type { KeyBindings } from './keys/store.ts';
import { chordPressOf, DEFAULT_KEY_TABLE, newlineKeyHint } from './keys/table.ts';
import type { ActionId, KeyContext, KeySpec, KeyTable } from './keys/table.ts';
import { a11yOf, applyA11y, NOTHING_ASKED, statusLine, statusLines } from './screen/a11y.ts';
import type { AskedA11y, StoredA11y } from './screen/a11y.ts';
import { AtList, AttachmentLines, heldAttachments } from './screen/attachments.tsx';
import type { Attachment } from './screen/attachments.tsx';
import { contextPercentOf, Footer, newlineHintText, planRowFits } from './screen/footer.tsx';
import { formatTokens } from '../format-tokens.ts';
import { HistoryView, useBackgroundAnswered } from './screen/history-view.tsx';
import type { ViewSource } from './screen/viewport.ts';
import { CHAT_MARK, InputBox, inputContentRows, inputOffsetAt, inputRowsOf } from './screen/input-box.tsx';
import { untilNextKey } from './screen/input.ts';
import type { ScreenTerminal } from './screen/input.ts';
import type { RowRequests } from './screen/layout.ts';
import { allocate, drawnTranscriptRows, inputTopOf, menuRowsCap, naturalRows, panelRowsCap, regionAt } from './screen/layout.ts';
import { chordContextsOf, keyRouteOf } from './screen/key-route.ts';
import type { KeyRoute, KeyRouteFacts } from './screen/key-route.ts';
import { INVITATION_ROWS, InvitationLine, invitationKeyOf, isMenuAction, useSlashMenu } from './screen/menu.tsx';
import { Screen } from './screen/screen.tsx';
import { createTranscriptStore } from './screen/store.ts';
import { SubagentRows } from './screen/subagents.tsx';
import { SCROLLBAR_COLUMNS, TranscriptView } from './screen/transcript-view.tsx';
import { usePromptPointer, usePrompts } from './screen/use-prompts.tsx';
import { useToolView } from './screen/tool-view.ts';
import { useTranscriptView } from './screen/use-transcript-view.ts';
import type { ScreenTimers } from './screen/timers.ts';
import { commandPhaseText, WaitingRow, waitingOf } from './screen/waiting-row.tsx';
import type { Loading, WaitingPhase } from './screen/waiting-row.tsx';
import { createSlashRegistry, modeToastText, namesOf, parseSlash, NEEDS_SESSION_NOTE } from './slash.ts';
import type { AutoModePort, SelectedText, ShellPort, SlashCommand, SlashRegistry } from './slash.ts';
import { extractSelection } from './screen/selection.ts';
import { COPY_MAX_BYTES } from './screen/constants.ts';
import { clipboardReadMessage } from './screen/clipboard.ts';

const READING_CLIPBOARD = 'reading the clipboard';
import { KEY_SETTLE_MS } from './terminal/constants.ts';
import type { KeyEvent, TerminalEvent } from './terminal/events.ts';
import type { ScreenMode } from './terminal/modes.ts';
import { NEWLINE_HINT } from './terminal/negotiation.ts';
import { UNSTORED_TUI_SETTINGS, useAttention } from './screen/notify.ts';
import type { NotifyMode, TuiSettingsPort } from './screen/notify.ts';
import { UNREPORTED_COLOUR_HOST, appearanceOf, applyAppearance, applyTheme } from './screen/theme.ts';
import type { ColourHost, ThemeId } from './screen/theme.ts';
import { appendEntry, BANNER_KEY, foldChildEvent, foldLiveEvent, foldReplayedEvent, blockingPrompt, nextMode, promptTakesFocus, runCreated, runLeft, sessionTokens, setThoughtWindow, shownRunPhase, subagentEnded, subagentStarted, thoughtWindowOf } from './transcript.ts';
import type { Entry } from './transcript.ts';
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
  return key === '' ? 'A task is running.' : `A task is running. ${key.charAt(0).toUpperCase()}${key.slice(1)} stops it.`;
};
export const EXIT_ARM_MS = 3000;
export const HISTORY_SEARCH_TITLE = 'History';

export const exitHint = (key: string): string => `Press ${key} again to exit`;

type ExitAction = Extract<ActionId, 'prompt.interrupt' | 'prompt.exit'>;

const MENU_CONTEXTS: readonly KeyContext[] = ['menu'];
const SHELL_CONTEXTS: readonly KeyContext[] = ['shell'];
const EDITOR_CONTEXTS: readonly KeyContext[] = ['chat', 'global'];

type Phase = { kind: 'starting' } | { kind: 'trust'; path: string } | { kind: 'welcome' } | { kind: 'unconnected' } | { kind: 'ready' };

const NO_MODEL_NOTE = messageOf('noModelConnected', 'tui');
const RESUBMIT_NOTICE = 'Signed in again. Retrying your last prompt.';

const PLAN_BLOCK_CODES: ReadonlySet<string> = new Set([PLAN_USE_NOT_ENABLED_CODE, PLAN_NOT_ELIGIBLE_CODE]);

const isUsageLimitCode = (code: string): boolean => USAGE_LIMIT_CODES.some((member) => member === code);

const CLEAR_SCREEN = '\u001b[2J\u001b[H';

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

type Replay = { queue: ReplayQueue; before: number; notes: NoteReplay | undefined };

type ScreenFacts = { overlay: boolean; position: Position; tasks: BackgroundTasks; terminal: ScreenTerminal; flush(): Promise<void> };

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
  const [store] = useState(createTranscriptStore);
  const [origins] = useState(() => createOrigins(store));
  useEffect(() => origins.stop, [origins]);
  useSyncExternalStore(store.subscribe, store.version);
  const transcript = store.state();
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
  const slash = createSlashRegistry([
    ...baseSlash.list(),
    modelPickerCommand(delegatingFlows),
    ...planSlashCommands(delegatingFlows),
    ...skillSlash,
  ]);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  const [mode, setModeState] = useState<PermissionMode>(props.initialMode ?? 'manual');
  const [bypassAllowed, setBypassAllowed] = useState(false);
  const [autoAvailable, setAutoAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<MomongaModelEntry | undefined>(undefined);
  const [sessionModel, setSessionModel] = useState<string | undefined>(undefined);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [displays, setDisplays] = useState<ReadonlyMap<string, string>>(new Map());
  const displaysRef = useRef<ReadonlyMap<string, string>>(new Map());
  const [found] = useState(createFoundServers);
  const unconfiguredModel = useRef(false);
  const capabilities: ChainCapabilities | undefined = model === undefined || isNotListedCapabilities(model.capabilities) ? undefined : model.capabilities;
  const [attachments, setAttachmentsState] = useState<readonly Attachment[]>([]);
  const [attachOn, setAttachOn] = useState(tuiSettings.initial.attachFileMentions);
  const imageCount = useRef(0);
  const shellRunning = useRef(false);
  const [reconnectingSince, setReconnectingSince] = useState<number | undefined>(undefined);
  const [measuring, setMeasuring] = useState<{ since: number; state: Measuring } | undefined>(undefined);
  const [commands, setCommands] = useState<readonly WaitingPhase[]>([]);
  const stopMeasuring = useRef<(() => void) | undefined>(undefined);
  const [switching, setSwitching] = useState(false);
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
  const [profiles, setProfiles] = useState<readonly PlanProfileView[]>([]);
  const [servedTarget, setServedTarget] = useState<string | undefined>(undefined);
  const typedRef = useRef(false);
  const sessionModelRef = useRef<string | undefined>(undefined);
  const signInFailedRun = useRef<{ text: string; options: StartRunOptions; sessionModel: string } | undefined>(undefined);
  const busyRef = useRef(false);
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
    const quiet = (): boolean => {
      const state = store.state();
      const now = facts.current;
      if (openedSession.current === undefined || phaseRef.current !== 'ready' || now.overlay) return false;
      if (readingRef.current || switchingRef.current || shellRunning.current || now.tasks.count() > 0) return false;
      if (state.approval !== undefined || state.elicitation !== undefined) return false;
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
  const attention = useAttention({
    terminal,
    cwd: backend.cwd,
    working: busy,
    prompting: phase.kind === 'trust' || transcript.approval !== undefined || transcript.elicitation !== undefined,
    notify,
    timers,
  });

  const enterPhase = (next: Phase): void => {
    phaseRef.current = next.kind;
    setPhase(next);
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

  const waitFor = <T,>(phase: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const waiting: WaitingPhase = { text: phase, startedAt: now() };
    setCommands((running) => [...running, waiting]);
    prompts.releaseHeldKeys();
    return tasks.run(work).finally(() => setCommands((running) => running.filter((other) => other !== waiting)));
  };

  const reportError = (error: unknown): void => {
    append({ kind: 'error', text: describeFailure(error) });
  };

  const shownModel = (stored: string): string => displaysRef.current.get(stored) ?? stored;

  const readDisplays = async (): Promise<ReadonlyMap<string, string>> => {
    const read = displayMapOf(listingViewsOf(await backend.models()));
    displaysRef.current = read;
    setDisplays(read);
    return read;
  };

  const bannerOf = (shownModel: StartupBanner['model'], shownNotices: readonly string[]): StartupBanner | undefined =>
    props.startup === undefined ? undefined : { config: props.startup, model: shownModel, cwd: backend.cwd, notices: shownNotices };

  const showBanner = (shownModel: StartupBanner['model'], shownNotices: readonly string[]): void => {
    const banner = bannerOf(shownModel, shownNotices);
    if (banner === undefined) return;
    if (store.byKey(BANNER_KEY) === undefined) store.append({ kind: 'banner', banner }, BANNER_KEY);
    else store.change(BANNER_KEY, () => ({ kind: 'banner', banner }));
  };

  const resetTranscript = (): void => {
    store.reset();
    renewHistory();
    if (sessionModelRef.current !== undefined) showBanner(shownModel(sessionModelRef.current), notices);
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
    stopMeasuring.current?.();
    stopMeasuring.current = undefined;
    setMeasuring(undefined);
  };

  const modelUnread = (error: unknown, announce = true): void => {
    endMeasuring();
    if (announce) append({ kind: 'notice', level: 'warning', text: `model information unavailable: ${errorOf(error).message}` });
  };

  const showModel = (entry: MomongaModelEntry, announce = true): void => {
    endMeasuring();
    setModel(entry);
    const readiness = agentReadiness(entry.capabilities);
    if (readiness.state === 'probing') {
      setMeasuring({ since: now(), state: readiness.measuring });
      stopMeasuring.current = followMeasurement(
        { read: () => backend.model(), timers },
        readiness.retryAfterSeconds,
        (measured) => showModel(measured),
        (error) => modelUnread(error),
        (state) => setMeasuring((before) => (before === undefined ? undefined : { since: before.since, state })),
      );
      return;
    }
    const text = readinessNoticeOf(readiness, 'tui');
    if (text !== undefined && announce) append({ kind: 'notice', level: 'warning', text });
  };

  const showSession = async (session: SessionView): Promise<void> => {
    openedSession.current = { id: session.id, hasRun: session.latestRunId !== null };
    setModeState(session.permissionMode);
    sessionModelRef.current = session.model;
    setSessionModel(session.model);
    setBypassAllowed(session.bypassAllowed);
    setAutoAvailable(await backend.autoModeAvailable());
    const configured = (await readDisplays()).has(session.model);
    unconfiguredModel.current = !configured;
    showBanner(shownModel(session.model), notices);
    const announce = !startsFromRecord.current;
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

  const openSession = async (chosen: string | undefined): Promise<void> => enterFirstSession(await backend.openSession(chosen));

  const runFlow = (work: () => Promise<void>): void => {
    prompts.flow(work).catch(reportError);
  };

  const applyModel = async (chosen: string): Promise<void> => {
    const previous = sessionModelRef.current;
    const session = await backend.setModel(chosen);
    sessionModelRef.current = session.model;
    setSessionModel(session.model);
    unconfiguredModel.current = false;
    await readDisplays();
    const name = shownModel(session.model);
    note(busyRef.current ? `model: ${name}; the running task keeps ${previous === undefined ? previous : shownModel(previous)}, the next task uses ${name}` : `model: ${name}; applies from the next task`);
    endMeasuring();
    void backend.model().then(showModel, modelUnread);
  };

  const rememberProfiles = (listed: PlanAccountsResponse): void => {
    setProfiles(listed.profiles);
  };

  const connectModel = async (chosen: string): Promise<void> => {
    if (sessionModelRef.current === undefined) {
      await openSession(chosen);
      return;
    }
    await applyModel(chosen);
  };

  const refreshConnection = async (): Promise<void> => {
    rememberProfiles(await backend.plan.accounts());
    if (sessionModelRef.current !== undefined) {
      await readDisplays();
      return;
    }
    if ((await backend.models()).length > 0) await openSession(undefined);
    else enterPhase({ kind: 'unconnected' });
  };

  const setWaitingMessages = (rows: readonly InboxRowView[]): void => {
    waitingRef.current = rows;
    setWaitingState(rows);
  };

  const refreshInbox = async (): Promise<void> => {
    setWaitingMessages(await backend.inbox.list());
  };

  const cancelNewest = (): void => {
    const runId = runIdRef.current;
    if (runId === undefined) {
      tasks.abortNewest();
      return;
    }
    backend.cancel(runId).catch(reportError);
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
    timers,
    keySettleMs: props.keySettleMs ?? KEY_SETTLE_MS,
    draftHeld: () => editorRef.current.text !== '',
    columns,
    panelRows: panelRowsCap(rows),
    keys,
    screenReader: a11y.screenReader,
    cancelNewest,
    reportError,
    fail,
    exit: () => finish({}),
    append,
    decideTrust,
    replayKeys: (events) => replayHeldKeys(events),
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

  const flows: PlanFlows = createPlanFlows({ ...overlayPorts, backend, info: note, toast: (text) => view.showToast(text), connected: connectModel, refreshConnection, signedIn: resubmitAfterSignIn, found, model: () => sessionModelRef.current, wait: waitFor, invitationAnswered: () => prompts.dismissInvitation(), untilNextKey: () => untilNextKey(terminal.input) });

  const showUsageLimit = async (code: string, plan: PlanAccountRef): Promise<void> => {
    const listed = await backend.plan.accounts();
    rememberProfiles(listed);
    const profile = profileOf(listed.profiles, plan.profile);
    append({ kind: 'notice', level: 'warning', text: `${profile.messages.identityLabel}\n${profile.messages.usageLimitMessage}` });
    if (code !== USAGE_PAUSED_CODE) await flows.usageLimit(profile);
  };

  const showPlanBlock = async (error: { code: string; message: string }, plan: PlanAccountRef): Promise<void> => {
    const listed = await backend.plan.accounts();
    rememberProfiles(listed);
    const profile = profileOf(listed.profiles, plan.profile);
    append({ kind: 'notice', level: 'error', text: `${profile.messages.identityLabel}\n${error.message}` });
    if (error.code === PLAN_USE_NOT_ENABLED_CODE) await flows.planUseNotEnabled(profile, plan.account);
    else await flows.notEligible(profile);
  };

  const offerInvitation = async (listed: PlanAccountsResponse): Promise<void> => {
    const dismissed = await backend.dismissedNotices();
    const invited = listed.profiles.find((profile) => accountsOf(profile.id, listed.accounts).length === 0 && !Object.hasOwn(dismissed, invitationKeyOf(profile.id)));
    if (invited === undefined || typedRef.current) return;
    prompts.invite({ profile: invited });
  };

  const connectAtLaunch = async (): Promise<void> => {
    const pending = await backend.trustItems();
    for (const sentence of pending.refused) append({ kind: 'notice', level: 'warning', text: sentence });
    const approved = await askTrustItems(pending.items, overlayPorts.choose);
    if (approved.length > 0) await backend.approveProjectItems(approved);
    const proposal = await backend.checkProposal();
    const check = proposal.ask ? await askProjectCheck(proposal.checks, overlayPorts) : undefined;
    if (check !== undefined) await backend.answerCheck(check);
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
    if (usable !== undefined) runFlow(() => flows.catalogPicker(profileOf(listed.profiles, usable.profile), usable.label));
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
            if (replay === undefined) foldLiveEvent(store, event, first);
            else foldReplayedEvent(store, event, first, (record) => showShellRecord(store, record, now()));
            if (key !== undefined) replay?.notes?.after(key);
          },
          replay === undefined || seq === undefined ? undefined : replay.before + seq,
        );
      },
      onChildEvent: (frame, agent) =>
        deliver(() => {
          setReconnectingSince(undefined);
          if (!isOpaqueEvent(frame.data)) foldChildEvent(store, frame.data, agent);
        }),
      onChildStarted: (agent, childRunId) => deliver(() => subagentStarted(store, agent, childRunId, now())),
      onChildEnded: (_agent, childRunId) => deliver(() => subagentEnded(store, childRunId)),
      onReconnecting: () => setReconnectingSince((since) => since ?? now()),
    });
  };

  const showRunEnd = (run: RunView): void => {
    if (run.status === 'CANCELLED') append({ kind: 'notice', level: 'info', text: describeRunEnd(run, 'tui') });
    else if (run.status !== 'COMPLETED') append({ kind: 'error', text: describeRunEnd(run, 'tui') });
  };

  const watchRun = async (runId: string, replay: Replay | undefined, resubmit: { text: string; options: StartRunOptions; sessionModel: string } | undefined): Promise<void> => {
    runIdRef.current = runId;
    const run = await follow(runId, replay);
    await replay?.queue.drained();
    setReconnectingSince(undefined);
    attention.runEnded(run.status === 'COMPLETED' ? 'done' : run.status === 'FAILED' ? 'error' : undefined);
    const stopped = run.error;
    if (run.status === 'FAILED' && stopped?.code === SIGN_IN_REQUIRED_CODE && resubmit !== undefined) signInFailedRun.current = resubmit;
    const plan = stopped?.plan;
    if (stopped !== undefined && plan !== undefined && isUsageLimitCode(stopped.code)) runFlow(() => showUsageLimit(stopped.code, plan));
    else if (stopped !== undefined && plan !== undefined && PLAN_BLOCK_CODES.has(stopped.code)) runFlow(() => showPlanBlock(stopped, plan));
    else showRunEnd(run);
  };

  const endReading = (): void => {
    readingRef.current = false;
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
    };
    const queue = createReplayQueue(timers, (done) => {
      setLoading(done < total ? { done, total, startedAt } : undefined);
      if (done >= total) caughtUp();
    });
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
          await watchRun(run.id, { queue, before, notes }, undefined);
          await watchQueuedRuns(run.id);
        }
        before += run.lastSeq;
      }
      await queue.drained();
      caughtUp();
      for (const record of await backend.userInput.pendingShell()) showShellRecord(store, record, now());
    } catch (error) {
      attention.runEnded('error');
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
    await readConversation(await backend.resumeSession(id), async (session) => {
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
        await refreshInbox();
        const next = await backend.inbox.successor(ended);
        if (next === undefined) return;
        runLeft(store);
        runCreated(store, next.id, now());
        await watchRun(next.id, undefined, undefined);
        ended = next.id;
      }
    } finally {
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
      attention.runEnded('error');
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
    replaceEditor(draft.state);
    setAttachments([]);
    backend.recordHistory(draft.text).catch(reportError);
    const refused = (error: unknown): void => {
      replaceEditor(placeText(editorRef.current, takenBack([draft.text], editorRef.current.text)));
      setAttachments([...sent, ...attachmentsRef.current]);
      if (!isInboxFull(error)) {
        reportError(error);
        return;
      }
      setHint(INBOX_FULL_HINT);
      refreshInbox().catch(reportError);
    };
    const accepted = async (): Promise<void> => {
      const added = await backend.inbox.add(delivery, draft.text, sent.map((attachment) => attachment.image));
      setWaitingMessages(added.pending);
      await resumeQueuedRuns();
    };
    accepted().catch(refused);
  };

  const takeBackWaiting = async (): Promise<void> => {
    const rows = waitingRef.current.toSorted((left, right) => left.seq - right.seq);
    const answers = await Promise.all(rows.map((row) => backend.inbox.withdraw(row.id)));
    const texts = answers.filter((answer) => answer.outcome === 'withdrawn').map((answer) => answer.row.text);
    const current = editorRef.current;
    replaceEditor(placeText(withHistory(current, texts.reduce(pushHistory, current.history)), takenBack(texts, current.text)));
    await refreshInbox();
  };

  type Resubmit = { text: string; options: StartRunOptions; sessionModel: string };

  const runStarted = async (prepare: () => { start: () => Promise<RunView>; resubmit: Resubmit | undefined }): Promise<void> => {
    setBusyState(true);
    disarmExit();
    attention.runEnded(undefined);
    signInFailedRun.current = undefined;
    const { start, resubmit } = prepare();
    try {
      const started = await start();
      if (openedSession.current !== undefined) openedSession.current.hasRun = true;
      runCreated(store, started.id, now());
      await watchRun(started.id, undefined, resubmit);
      await watchQueuedRuns(started.id);
    } catch (error) {
      attention.runEnded('error');
      if (!exiting.current) reportError(error);
    } finally {
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
      for (const attachment of sent) note(`attached ${describeAttachment(attachment.file, attachment.image)}`);
      const runOptions: StartRunOptions = {
        ...options,
        ...(sent.length === 0 ? {} : { images: [...(options.images ?? []), ...sent.map((attachment) => attachment.image)] }),
        ...(attachOn && hasMentionToken(text) ? { attachMentions: true } : {}),
      };
      const runModel = sessionModelRef.current;
      return { start: () => backend.startRun(text, runOptions), resubmit: runModel === undefined ? undefined : { text, options: runOptions, sessionModel: runModel } };
    });

  const runCompaction = (instructions: string | undefined): Promise<void> =>
    runStarted(() => {
      append({ kind: 'user', text: instructions === undefined ? '/compact' : `/compact ${instructions}` });
      return { start: () => backend.compact(instructions), resubmit: undefined };
    });

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
      found,
      wait: waitFor,
      toast: (text) => view.showToast(text),
      refreshConnection,
      bypassAllowed,
      autoAvailable,
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
      sessions: { startNew: startNewSession, resume: resumeSession, now, columns: () => terminal.state().size.columns },
      exit: () => finish({}),
      background: (label, work) => waitFor(commandPhaseText(label), work),
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
      overlays: { choose: overlayPorts.choose, promptText: overlayPorts.promptText },
      externalEditor,
      clipboard: { selected: selectedText, lastAnswer },
      refusedWhileRunning: refusedWhileWorking,
      status: () => statusLines(statusFacts()),
      setMode: async (chosen) => {
        const session = await backend.setMode(chosen);
        setModeState(session.permissionMode);
        view.showToast(modeToastText(session.permissionMode));
        showAutoNotice(session);
      },
      setModel: applyModel,
    });
    await ran;
    return true;
  };

  const submit = async (text: string): Promise<void> => {
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
      replaceEditor(placeText(editorRef.current, text));
      await flows.modelPicker(sessionModel);
      if (unconfiguredModel.current || editorRef.current.text !== text) return;
      replaceEditor(placeText(editorRef.current, ''));
      await runPrompt(text);
      return;
    }
    await runPrompt(text);
  };

  const submitSafely = (text: string): void => {
    prompts.flow(() => submit(text)).catch(reportError);
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
    prompts.flow(send).catch(reportError);
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
      .setMode(nextMode({ current: mode, bypassAllowed, autoAvailable }))
      .then((session) => {
        setModeState(session.permissionMode);
        view.showToast(modeToastText(session.permissionMode));
        showAutoNotice(session);
      }, reportError);
  };


  const unconnected = phase.kind === 'unconnected';
  const syncBanner = useEffectEvent((): void => {
    if (sessionModel === undefined ? unconnected : store.byKey(BANNER_KEY) !== undefined) showBanner(sessionModel === undefined ? undefined : (displays.get(sessionModel) ?? sessionModel), notices);
  });
  useEffect(() => {
    syncBanner();
  }, [sessionModel, notices, unconnected, displays]);

  useEffect(
    () => () => {
      stopMeasuring.current?.();
    },
    [],
  );

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
    await tasks.run((signal) => tuiSettings.save('attachFileMentions', next, signal));
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
    tasks.run(work).catch(reportError);
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
    replaceEditor(outcome.state);
    backend.recordHistory(outcome.text).catch(reportError);
    submitSafely(outcome.text);
  };

  const onEditorAction = (action: ActionId | undefined, typed: string | undefined): void => {
    const starting = phase.kind === 'starting';
    const working = busyRef.current || commands.length > 0;
    const current = editorRef.current;
    if (action === 'prompt.submit') onEnter();
    else if (action === 'prompt.queue' || action === 'prompt.steer') {
      const delivery = busyDeliveryOf(keys, action);
      if (busyRef.current && delivery !== undefined) sendWhileBusy(delivery);
    } else if (action === 'editor.up' && waitingRef.current.length > 0 && onFirstLine(current)) runFlow(takeBackWaiting);
    else if (action === 'transcript.detail') {
      if (!starting) toolView.showNewest();
    } else if (action === 'run.stop') {
      if (working) cancelNewest();
      else if (invitationShown) prompts.dismissInvitation();
    } else if (action === 'prompt.interrupt') {
      if (starting) finish({});
      else if (working) cancelNewest();
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
    else if (isEditorAction(action)) replaceEditor(applyAction(current, action));
    else if (action === undefined && typed !== undefined) replaceEditor(typedIntoDraft(current, typed));
  };

  const routeFacts = (): KeyRouteFacts => ({
    trust: phase.kind === 'trust',
    toolView: toolView.shown,
    overlay: prompts.overlayKind(),
    betweenLists: prompts.betweenLists(),
    welcome: phase.kind === 'welcome',
    prompt: prompts.promptStage(),
    detail: prompts.detailShown(panelFacts),
    shellDraft: editorRef.current.shell,
    menuOpen: slashMenu.open || atMenu.open,
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
      case 'between-lists':
        if (!prompts.holdKey(event, pressed)) routeKey(keyRouteOf(routeFacts()), event, pressed);
        return;
      case 'welcome':
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

  const onKey = (event: KeyEvent, pressed: KeyTable): void => {
    bindings.poll(now());
    const action = pressed.actionOf(EDITOR_CONTEXTS, event);
    if (armedExit.current === undefined || armedExit.current.action !== action) {
      disarmExit();
      setHint(undefined);
    }
    routeKey(keyRouteOf(routeFacts()), event, pressed);
  };

  const replayHeldKeys = useEffectEvent((events: readonly KeyEvent[]): void => {
    for (const event of events) {
      const route = keyRouteOf(routeFacts());
      if (route === 'shell' || route === 'menu' || route === 'editor') onKey(event, keys);
    }
  });

  const onPaste = (text: string): void => {
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
  const inputShown = (phase.kind === 'starting' || phase.kind === 'ready' || phase.kind === 'unconnected') && panel === undefined;
  const completionOpen = slashMenu.open || atMenu.open;
  const menuShown = inputShown && (invitationShown || completionOpen);
  const shownAttachments = heldAttachments(attachments, editor.pastes);
  const waitingLines = inputShown ? waitingRows(waitingMessages, columns) : [];
  const busyHintRow = !inputShown || phase.kind !== 'ready' ? undefined : shellDraft ? shellHint(keys) : !busy ? undefined : slashMenu.open || atMenu.open ? completionHint(keys) : busyHint(keys, waitingMessages.length > 0);
  const invitationInMenu = menuShown && phase.kind === 'ready' && invitationShown;
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
  const rowRequests: RowRequests = {
    waiting: waiting === undefined || a11y.screenReader ? 0 : 1,
    inputRows: inputRowsOf(editor, columns),
    invitation: invitationInMenu ? INVITATION_ROWS : 0,
    menu: !menuShown || invitationInMenu ? 0 : atMenu.open ? atMenu.rows : slashMenu.rows,
    subagents: transcript.subagents.length,
    footerSecond: (!fullscreen || planRowFits(planRow, columns) ? (planRow === undefined ? 0 : 1) : 0) + (busyHintRow === undefined ? 0 : 1),
    lines: inputShown ? shownAttachments.length + waitingLines.length : 0,
    panel: panel === undefined ? undefined : (panelRows ?? 0),
  };
  const allocation = allocate(rows, rowRequests);
  const busyHintRows = busyHintRow === undefined || (fullscreen && allocation.footer < 2) ? 0 : 1;
  const transcriptWidth = fullscreen ? Math.max(1, columns - SCROLLBAR_COLUMNS) : columns;
  const view = useTranscriptView({
    store,
    terminal,
    fullscreen: fullscreen && !switching,
    width: transcriptWidth,
    allocation,
    copyOnSelect,
    now,
    copy: (text) => backend.copyToClipboard(text),
    openLink: (url) => backend.openUrl(url, untilNextKey(terminal.input), (message) => reportError(new Error(message))),
    reportError,
    keyFacts: () => ({ panelOpen: panel !== undefined || toolView.shown, menuOpen: completionOpen, inputEmpty: editorRef.current.text === '' }),
    keys,
    a11y,
    timers,
  });
  const toolView = useToolView({
    store,
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
    allocation,
    panelOpen: panel !== undefined,
    menuOpen: inputShown && completionOpen,
    panelPress: (row) => prompts.press(panelFacts, row),
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
  const onChord = useEffectEvent((event: TerminalEvent): boolean => {
    if (event.type !== 'key') return false;
    const step = keys.chordStep(chordContextsOf(routeFacts()), chord.current, event);
    chord.current = step.kind === 'pending' ? step.prefix : undefined;
    if (step.kind === 'none') return false;
    if (step.kind === 'action' && !view.act(step.id)) onKey(event, chordPressOf(keys, step.id));
    return true;
  });
  useEffect(() => terminal.input.claim('chord', (event) => onChord(event)), [terminal]);
  useEffect(() => {
    facts.current = { overlay: overlay !== undefined, position: view.position, tasks, terminal, flush: waitUntilRenderFlush };
    feedRef.current = feed;
    sourceRef.current = view.source;
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
  const statusFacts = (): { mode: string; tokens: string; context: string } => {
    const percent = contextPercentOf(transcript.contextTokens, capabilities?.contextWindow);
    return { mode, tokens: formatTokens(sessionTokens(transcript)), context: percent === undefined ? 'unknown' : `${percent}%` };
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
  }, [store, thoughtWindow]);
  const footerFacts =
    phase.kind === 'ready' && overlay === undefined && !a11y.screenReader
      ? {
          mode,
          tokens: sessionTokens(transcript),
          contextPercent: contextPercentOf(transcript.contextTokens, capabilities?.contextWindow),
          imageInput,
          answer: shownHint,
          newline: newlineHintText(newlineKeyHint(keys, terminalState.negotiation)),
        }
      : undefined;

  return (
    <Screen
      view={switching || erased || terminalState.tooSmall ? 'blank' : terminalState.screen}
      columns={columns}
      rows={rows}
      allocation={allocation}
      panel={panel ?? (fullscreen || !toolView.shown ? undefined : toolView.view)}
      onPanelRows={setPanelRows}
      regions={{
        transcript: fullscreen && toolView.shown ? (
          toolView.view
        ) : fullscreen ? (
          <TranscriptView window={view.window} height={panel === undefined ? allocation.viewport : drawnTranscriptRows(allocation.viewport, view.window.rows.length)} width={transcriptWidth} entries={store.count()} following={view.position.following} selection={view.selection} />
        ) : (
          <HistoryView key={historyGeneration} store={store} source={view.source} feed={feed} ready={scrollbackReady} timers={timers} columns={transcriptWidth} />
        ),
        menu: !menuShown ? null : invitationInMenu && prompts.invitation !== undefined ? <InvitationLine invitation={prompts.invitation} keys={keys} /> : atMenu.open ? <AtList labels={atMenu.labels} index={atMenu.index} /> : slashMenu.view(fullscreen ? allocation.menu : slashMenu.rows),
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
        ) : null,
        input: inputShown ? <InputBox editor={editor} mark={shellDraft ? SHELL_MARK : CHAT_MARK} columns={columns} framed={!a11y.screenReader} rows={fullscreen ? inputContentRows(allocation.input) : undefined} top={inputTopOf(fullscreen ? allocation : naturalRows(feed.live(view.source, store.settledAt).length, rowRequests))} /> : null,
        footer: (
          <>
            <Footer facts={footerFacts} hint={a11y.screenReader ? undefined : hint} unconnected={phase.kind === 'unconnected'} planRow={a11y.screenReader ? undefined : planRow} width={columns} rows={fullscreen ? allocation.footer - busyHintRows : 2} keys={keys} />
            {busyHintRow === undefined || busyHintRows === 0 ? null : (
              <Text dimColor wrap="truncate">
                {busyHintRow}
              </Text>
            )}
          </>
        ),
        subagents: <SubagentRows subagents={a11y.screenReader ? [] : transcript.subagents} rows={fullscreen ? allocation.subagents : transcript.subagents.length} now={now} timers={timers} />,
      }}
    />
  );
}
