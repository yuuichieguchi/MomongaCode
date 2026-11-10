import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { useApp, useInput, usePaste, useStdout } from 'ink';
import { PLAN_NOT_ELIGIBLE_CODE, PLAN_USE_NOT_ENABLED_CODE, SIGN_IN_REQUIRED_CODE, USAGE_LIMIT_CODES, USAGE_PAUSED_CODE, agentReadiness, autoModeNotice, isNotListedCapabilities } from '@momonga/protocol';
import type { AliasCapabilities, MomongaModelEntry, PermissionMode, PlanAccountRef, PlanAccountsResponse, PlanProfileView } from '@momonga/protocol';
import type { RunView, SessionView } from '../client/views.ts';
import { describeAttachment, pastedImagePaths } from '../images.ts';
import { describeFailure } from '../failure.ts';
import { readinessNoticeOf } from '../readiness.ts';
import { describeRunEnd } from '../run/headless.ts';
import { accountsOf, profileOf } from '../plan/accounts.ts';
import type { StartRunOptions, TuiBackend } from './backend.ts';
import { createBackgroundTasks } from './background-tasks.ts';
import type { BackgroundTasks } from './background-tasks.ts';
import { autoNoticeDue } from './notices.ts';
import type { AutoNoticePair } from './notices.ts';
import { DEFAULT_SLASH_COMMANDS } from './commands/index.ts';
import { modelPickerCommand, planSlashCommands } from './commands/auth.ts';
import { createPlanFlows } from './plan-flows.ts';
import type { PlanFlows } from './plan-flows.ts';
import type { StartupBanner, StartupConfig } from './startup.tsx';
import { skillCommands } from './commands/skills.ts';
import { applyKey, emptyEditor } from './editor.ts';
import type { EditorState } from './editor.ts';
import { AttachmentLines } from './screen/attachments.tsx';
import type { Attachment } from './screen/attachments.tsx';
import { SCREEN_SETTINGS } from './screen/constants.ts';
import { contextPercentOf, Footer, newlineHintText, planRowFits } from './screen/footer.tsx';
import { HistoryView } from './screen/history-view.tsx';
import { InputBox, inputRowsOf } from './screen/input-box.tsx';
import type { ScreenTerminal } from './screen/input.ts';
import { allocate, panelRowsCap } from './screen/layout.ts';
import { COMPLETION_ROWS, CompletionMenu, INVITATION_ROWS, InvitationMenu } from './screen/menu.tsx';
import { Screen } from './screen/screen.tsx';
import { createTranscriptStore } from './screen/store.ts';
import { SubagentRows } from './screen/subagents.tsx';
import { SCROLLBAR_COLUMNS, TranscriptView } from './screen/transcript-view.tsx';
import { usePrompts } from './screen/use-prompts.tsx';
import { useTranscriptView } from './screen/use-transcript-view.ts';
import { WaitingRow, waitingText } from './screen/waiting-row.tsx';
import { createSlashRegistry, parseSlash, slashCompletion } from './slash.ts';
import type { AutoModePort, ShellPort, SlashCommand, SlashRegistry } from './slash.ts';
import type { ScreenMode } from './terminal/modes.ts';
import { appendEntry, BANNER_KEY, foldChildEvent, foldEvent, nextMode, sessionTokens, subagentEnded, subagentStarted } from './transcript.ts';
import type { Entry } from './transcript.ts';

export type TuiOutcome = { error?: Error };

export type AppProps = {
  backend: TuiBackend;
  terminal: ScreenTerminal;
  initialMode: PermissionMode | undefined;
  initialPrompt?: string;
  initialImages?: readonly string[];
  initialSkill?: string;
  startup?: StartupConfig;
  slash?: SlashRegistry;
  tasks?: BackgroundTasks;
  autoMode?: AutoModePort;
  shell?: ShellPort;
  copyOnSelect?: boolean;
  now(): number;
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

type Phase = { kind: 'starting' } | { kind: 'trust'; path: string } | { kind: 'welcome' } | { kind: 'unconnected' } | { kind: 'ready' };

const NO_MODEL_NOTE = 'No model is connected. Use /login to connect one.';
const RESUBMIT_NOTICE = 'Signed in again. Retrying your last prompt.';
const NEEDS_SESSION_NOTE = 'This command needs a session. Connect a model first with /login.';

const PLAN_BLOCK_CODES: ReadonlySet<string> = new Set([PLAN_USE_NOT_ENABLED_CODE, PLAN_NOT_ELIGIBLE_CODE]);

const isUsageLimitCode = (code: string): boolean => USAGE_LIMIT_CODES.some((member) => member === code);

const CLEAR_SCREEN = '\u001b[2J\u001b[3J\u001b[H';

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export function App(props: AppProps) {
  const { backend, terminal, onExit } = props;
  const { exit, waitUntilRenderFlush } = useApp();
  const { stdout } = useStdout();
  const terminalState = useSyncExternalStore(terminal.subscribe, terminal.state);
  const { columns, rows } = terminalState.size;
  const [store] = useState(createTranscriptStore);
  useSyncExternalStore(store.subscribe, store.version);
  const transcript = store.state();
  const { now } = props;
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
    ...baseSlash.list().map((command) => (command.name === 'model' ? modelPickerCommand(delegatingFlows) : command)),
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
  const [alias, setAlias] = useState<string | undefined>(undefined);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const capabilities: AliasCapabilities | undefined = model === undefined || isNotListedCapabilities(model.capabilities) ? undefined : model.capabilities;
  const [attachments, setAttachmentsState] = useState<readonly Attachment[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [historyGeneration, setHistoryGeneration] = useState(0);
  const [panelRows, setPanelRows] = useState<number | undefined>(undefined);
  const nextHistory = useRef<'inherit' | 'fresh'>('inherit');
  const initialPromptSent = useRef(false);
  const exiting = useRef(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<EditorState>(editor);
  const attachmentsRef = useRef<readonly Attachment[]>([]);
  const [profiles, setProfiles] = useState<readonly PlanProfileView[]>([]);
  const [servedTarget, setServedTarget] = useState<string | undefined>(undefined);
  const typedRef = useRef(false);
  const aliasRef = useRef<string | undefined>(undefined);
  const signInFailedRun = useRef<{ text: string; options: StartRunOptions; alias: string } | undefined>(undefined);
  const busyRef = useRef(false);

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

  const append = (entry: Entry): void => {
    appendEntry(store, entry);
  };

  const finish = (outcome: TuiOutcome): void => {
    exiting.current = true;
    onExit(outcome);
    exit();
  };

  const fail = (error: unknown): void => {
    finish({ error: errorOf(error) });
  };

  const note = (text: string): void => {
    append({ kind: 'info', text });
  };

  const reportError = (error: unknown): void => {
    append({ kind: 'notice', level: 'error', text: describeFailure(error) });
  };

  const bannerOf = (shownModel: StartupBanner['model'], shownMode: string, shownNotices: readonly string[]): StartupBanner | undefined =>
    props.startup === undefined ? undefined : { config: props.startup, model: shownModel, mode: shownMode, cwd: backend.cwd, notices: shownNotices };

  const showBanner = (shownModel: StartupBanner['model'], shownMode: string, shownNotices: readonly string[]): void => {
    const banner = bannerOf(shownModel, shownMode, shownNotices);
    if (banner === undefined) return;
    if (store.byKey(BANNER_KEY) === undefined) store.append({ kind: 'banner', banner }, BANNER_KEY);
    else store.change(BANNER_KEY, () => ({ kind: 'banner', banner }));
  };

  const resetTranscript = (): void => {
    store.reset();
    setHistoryGeneration((generation) => generation + 1);
    if (aliasRef.current !== undefined) showBanner({ alias: aliasRef.current, targets: model?.targets }, mode, notices);
  };

  const switchScreen = async (next: ScreenMode): Promise<void> => {
    if (terminal.state().screen !== next) {
      setSwitching(true);
      await waitUntilRenderFlush();
      terminal.setScreen(next);
      setHistoryGeneration((generation) => generation + 1);
      setSwitching(false);
    }
    note(`screen: ${next}`);
  };

  const showAutoNotice = (session: SessionView): void => {
    const view = session.autoClassifier;
    if (session.permissionMode !== 'auto' || view === undefined) return;
    if (!autoNoticeDue(lastAutoNotice.current, view)) return;
    lastAutoNotice.current = { key: view.key, measurement: view.measurement };
    note(autoModeNotice({ view, surface: 'tui' }));
  };

  const showModel = (entry: MomongaModelEntry): void => {
    setModel(entry);
    const text = readinessNoticeOf(agentReadiness(entry.capabilities));
    if (text !== undefined) append({ kind: 'notice', level: 'warning', text });
  };

  const openSession = async (modelAlias: string | undefined): Promise<void> => {
    const session = await backend.openSession(modelAlias);
    setModeState(session.permissionMode);
    aliasRef.current = session.modelAlias;
    setAlias(session.modelAlias);
    setBypassAllowed(session.bypassAllowed);
    setAutoAvailable(await backend.autoModeAvailable());
    replaceEditor(emptyEditor(await backend.loadHistory()));
    showBanner({ alias: session.modelAlias, targets: undefined }, session.permissionMode, []);
    showAutoNotice(session);
    setPhase({ kind: 'ready' });
    void backend.model().then(showModel, (error: unknown) => {
      append({ kind: 'notice', level: 'warning', text: `model information unavailable: ${errorOf(error).message}` });
    });
    void backend.startupNotices().then(
      (found) => setNotices((previous) => [...previous, ...found]),
      (error: unknown) => {
        append({ kind: 'notice', level: 'warning', text: `startup notices unavailable: ${errorOf(error).message}` });
      },
    );
    void backend.skills().then(
      ({ skills }) => {
        const taken = new Set(baseSlash.list().flatMap((command) => [command.name, ...(command.aliases ?? [])]));
        const loaded = skillCommands(skills, taken);
        setSkillSlash(loaded.commands);
        if (loaded.shadowed.length > 0) note(`skills shadowed by a built-in command and reachable only through the model: ${loaded.shadowed.join(', ')}`);
      },
      (error: unknown) => {
        append({ kind: 'notice', level: 'warning', text: `skills unavailable: ${errorOf(error).message}` });
      },
    );
  };

  const runFlow = (work: () => Promise<void>): void => {
    work().catch(reportError);
  };

  const applyModel = async (chosen: string): Promise<void> => {
    const previous = aliasRef.current;
    const session = await backend.setModel(chosen);
    aliasRef.current = session.modelAlias;
    setAlias(session.modelAlias);
    note(
      busyRef.current
        ? `model: ${session.modelAlias}; the running task keeps ${previous}, the next task uses ${session.modelAlias}`
        : `model: ${session.modelAlias}; applies from the next task`,
    );
    void backend.model().then(showModel, (error: unknown) => {
      append({ kind: 'notice', level: 'warning', text: `model information unavailable: ${errorOf(error).message}` });
    });
  };

  const rememberProfiles = (listed: PlanAccountsResponse): void => {
    setProfiles(listed.profiles);
  };

  const connectAlias = async (chosen: string): Promise<void> => {
    if (aliasRef.current === undefined) {
      await openSession(chosen);
      return;
    }
    await applyModel(chosen);
  };

  const refreshConnection = async (): Promise<void> => {
    rememberProfiles(await backend.plan.accounts());
    if (aliasRef.current !== undefined) return;
    if ((await backend.models()).length > 0) await openSession(undefined);
    else setPhase({ kind: 'unconnected' });
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
    cancelNewest,
    reportError,
    fail,
    exit: () => finish({}),
    append,
    decideTrust,
    acceptInvitation: (invitation) => runFlow(() => flows.providerFlow(invitation.profile)),
  });
  const { overlayPorts, overlay } = prompts;

  const resubmitAfterSignIn = async (): Promise<void> => {
    const kept = signInFailedRun.current;
    if (kept === undefined) return;
    const [entries, health] = await Promise.all([backend.models(), backend.health()]);
    const entry = entries.find((candidate) => candidate.id === kept.alias);
    if (entry === undefined || !entry.targets.some((target) => health.targets[target]?.ok === true)) return;
    signInFailedRun.current = undefined;
    note(RESUBMIT_NOTICE);
    await runPrompt(kept.text, kept.options);
  };

  const flows: PlanFlows = createPlanFlows({ ...overlayPorts, backend, info: note, connected: connectAlias, refreshConnection, signedIn: resubmitAfterSignIn });

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
    const invited = listed.profiles.find((profile) => accountsOf(profile.id, listed.accounts).length === 0 && !Object.hasOwn(dismissed, `invite:${profile.id}`));
    if (invited === undefined || typedRef.current) return;
    prompts.invite({ profile: invited });
  };

  const connectAtLaunch = async (): Promise<void> => {
    const [entries, listed] = await Promise.all([backend.models(), backend.plan.accounts()]);
    rememberProfiles(listed);
    if (entries.length > 0) {
      await openSession(undefined);
      runFlow(() => offerInvitation(listed));
      return;
    }
    if (listed.accounts.length === 0) {
      setPhase({ kind: 'welcome' });
      runFlow(async () => {
        try {
          await flows.welcome(listed.profiles);
        } finally {
          if (aliasRef.current === undefined) setPhase({ kind: 'unconnected' });
        }
      });
      return;
    }
    setPhase({ kind: 'unconnected' });
    const usable = listed.accounts.find((account) => account.active && (account.state === 'active' || account.state === 'plan_disabled'));
    if (usable !== undefined) runFlow(() => flows.catalogPicker(profileOf(listed.profiles, usable.profile), usable.label));
  };

  const boot = useEffectEvent(async (): Promise<void> => {
    try {
      const trust = await backend.boot();
      if (trust.decision === null) {
        setPhase({ kind: 'trust', path: trust.path });
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

  const runPrompt = async (text: string, options: StartRunOptions = {}): Promise<void> => {
    setBusyState(true);
    signInFailedRun.current = undefined;
    const sent = attachmentsRef.current;
    setAttachments([]);
    append({ kind: 'user', text });
    for (const attachment of sent) note(`attached ${describeAttachment(attachment.file, attachment.image)}`);
    try {
      const history = nextHistory.current;
      nextHistory.current = 'inherit';
      const runOptions: StartRunOptions = { ...options, ...(sent.length === 0 ? {} : { images: [...(options.images ?? []), ...sent.map((attachment) => attachment.image)] }) };
      const runAlias = aliasRef.current;
      const started = await backend.startRun(text, history, runOptions);
      runIdRef.current = started.id;
      store.update({ runId: started.id, runStatus: 'QUEUED' });
      const run: RunView = await backend.follow(started.id, {
        onEvent: (frame) => {
          setReconnecting(false);
          if (frame.data.type === 'model.responded' && frame.data.target !== undefined) setServedTarget(frame.data.target);
          foldEvent(store, frame.data);
        },
        onChildEvent: (frame, agent) => {
          setReconnecting(false);
          foldChildEvent(store, frame.data, agent);
        },
        onChildStarted: (agent, runId) => subagentStarted(store, agent, runId, now()),
        onChildEnded: (_agent, runId) => subagentEnded(store, runId),
        onReconnecting: () => setReconnecting(true),
      });
      setReconnecting(false);
      const stopped = run.error;
      if (run.status === 'FAILED' && stopped?.code === SIGN_IN_REQUIRED_CODE && runAlias !== undefined) signInFailedRun.current = { text, options: runOptions, alias: runAlias };
      const plan = stopped?.plan;
      if (stopped !== undefined && plan !== undefined && isUsageLimitCode(stopped.code)) runFlow(() => showUsageLimit(stopped.code, plan));
      else if (stopped !== undefined && plan !== undefined && PLAN_BLOCK_CODES.has(stopped.code)) runFlow(() => showPlanBlock(stopped, plan));
      else if (run.status !== 'COMPLETED') append({ kind: 'notice', level: run.status === 'CANCELLED' ? 'info' : 'error', text: describeRunEnd(run, 'tui') });
    } catch (error) {
      if (!exiting.current) reportError(error);
    } finally {
      runIdRef.current = undefined;
      setBusyState(false);
    }
  };

  const runSlash = async (line: string): Promise<boolean> => {
    const parsed = parseSlash(line);
    if (parsed === undefined) return false;
    const command = slash.find(parsed.name);
    if (command === undefined) {
      note(`unknown command /${parsed.name}; /help lists the commands`);
      return true;
    }
    if (alias === undefined && command.needsSession !== false) {
      note(NEEDS_SESSION_NOTE);
      return true;
    }
    const ran = command.run(parsed.args, {
      mode,
      modelAlias: alias,
      bypassAllowed,
      autoAvailable,
      commands: slash.list(),
      backend,
      info: note,
      startRun: async (task, runOptions) => {
        if (busy) {
          note('a task is running; press esc to cancel it');
          return;
        }
        await runPrompt(task, runOptions);
      },
      clear: () => {
        signInFailedRun.current = undefined;
        nextHistory.current = 'fresh';
        resetTranscript();
        if (terminal.state().screen === 'scrollback') stdout.write(CLEAR_SCREEN);
      },
      exit: () => finish({}),
      background: (label, work) => {
        note(`${label}: running (esc cancels)`);
        return tasks.run(work);
      },
      autoMode: props.autoMode ?? unavailableAutoMode,
      shell: props.shell ?? unavailableShell,
      screen: { current: () => terminal.state().screen, set: switchScreen },
      setMode: async (chosen) => {
        const session = await backend.setMode(chosen);
        setModeState(session.permissionMode);
        note(`permission mode: ${session.permissionMode}`);
        showAutoNotice(session);
      },
      setModel: applyModel,
    });
    try {
      await ran;
    } finally {
      prompts.closeLoading();
    }
    return true;
  };

  const submit = async (text: string): Promise<void> => {
    if (text.trim().startsWith('/')) {
      await runSlash(text);
      return;
    }
    if (busy) {
      note('a task is running; press esc to cancel it');
      return;
    }
    if (alias === undefined) {
      note(NO_MODEL_NOTE);
      return;
    }
    await runPrompt(text);
  };

  const submitSafely = (text: string): void => {
    submit(text).catch(reportError);
  };

  const sendInitialPrompt = useEffectEvent((): void => {
    if (initialPromptSent.current) return;
    initialPromptSent.current = true;
    const { initialPrompt, initialImages, initialSkill } = props;
    const send = async (): Promise<void> => {
      if (initialImages !== undefined && initialImages.length > 0) await attach(initialImages);
      if (initialPrompt === undefined) return;
      if (initialSkill === undefined) await submit(initialPrompt);
      else await runPrompt(initialPrompt, { skill: initialSkill });
    };
    send().catch(reportError);
  });

  useEffect(() => {
    if (phase.kind === 'ready') sendInitialPrompt();
  }, [phase.kind]);

  const attach = async (files: readonly string[]): Promise<void> => {
    const added: Attachment[] = [];
    for (const file of files) added.push({ file, image: await backend.readImage(file) });
    setAttachments([...attachmentsRef.current, ...added]);
  };

  const cycleMode = (): void => {
    backend
      .setMode(nextMode({ current: mode, bypassAllowed, autoAvailable }))
      .then((session) => {
        setModeState(session.permissionMode);
        showAutoNotice(session);
      }, reportError);
  };


  const bannerTargets = model?.targets;
  const syncBanner = useEffectEvent((): void => {
    if (alias !== undefined && store.byKey(BANNER_KEY) !== undefined) showBanner({ alias, targets: bannerTargets }, mode, notices);
  });
  useEffect(() => {
    syncBanner();
  }, [alias, bannerTargets, mode, notices]);

  useEffect(
    () =>
      terminal.subscribeScreen((request) => {
        if (request.type === 'notice') appendEntry(store, { kind: 'notice', level: 'warning', text: request.text });
      }),
    [terminal, store],
  );

  const imageInput = capabilities?.imageInput === true;

  usePaste(
    (text) => {
      if (prompts.overlay?.kind === 'waiting') {
        prompts.paste(text);
        return;
      }
      const paths = imageInput ? pastedImagePaths(text) : undefined;
      if (paths !== undefined) {
        attach(paths).catch(reportError);
        return;
      }
      if (prompts.paste(text)) return;
      replaceEditor(applyKey(editorRef.current, { input: text }).state);
    },
    { isActive: (phase.kind === 'ready' && transcript.approval === undefined) || overlay?.kind === 'waiting' },
  );

  const invitationShown = prompts.invitation !== undefined && overlay === undefined && !busy && editor.text === '';

  useInput((input, key) => {
    if (phase.kind === 'starting') {
      if (key.ctrl && input === 'c') finish({});
      return;
    }
    if (phase.kind === 'trust') {
      prompts.trustKey(input, key);
      return;
    }
    if (prompts.overlayKey(input, key)) return;
    if (phase.kind === 'welcome') return;
    if (!busy && editorRef.current.text === '' && prompts.invitationKey(input, key)) return;
    if (input !== '' && !key.ctrl && !key.meta) {
      typedRef.current = true;
      prompts.dismissInvitation();
    }
    if (key.tab && key.shift) {
      if (alias === undefined) return;
      cycleMode();
      return;
    }
    if (prompts.runPromptKey(input, key)) return;
    if (key.escape) {
      cancelNewest();
      return;
    }
    if (key.ctrl && input === 'c') {
      if (busy) cancelNewest();
      else if (editorRef.current.text === '') finish({});
      else replaceEditor(emptyEditor(editorRef.current.history));
      return;
    }
    if (key.ctrl && input === 'd' && editorRef.current.text === '') {
      finish({});
      return;
    }
    if ((key.backspace || key.delete) && editorRef.current.text === '' && attachmentsRef.current.length > 0) {
      setAttachments(attachmentsRef.current.slice(0, -1));
      return;
    }
    if (key.tab) {
      const completion = slashCompletion(editorRef.current.text, slash.list());
      if (completion !== undefined) replaceEditor({ ...editorRef.current, text: completion.completed, cursor: completion.completed.length, historyIndex: undefined });
      return;
    }
    const outcome = applyKey(editorRef.current, { ...key, input });
    if (outcome.submit !== undefined && alias === undefined && !outcome.submit.trim().startsWith('/')) {
      note(NO_MODEL_NOTE);
      return;
    }
    replaceEditor(outcome.state);
    if (outcome.submit !== undefined) {
      backend.recordHistory(outcome.submit).catch(reportError);
      submitSafely(outcome.submit);
    }
  });

  const completion = phase.kind === 'ready' ? slashCompletion(editor.text, slash.list()) : undefined;
  const servedPlan = servedTarget === undefined || model?.targetBilling?.[servedTarget] !== 'plan' ? undefined : model.targetPlan?.[servedTarget];
  const servedProfile = servedPlan === undefined ? undefined : profiles.find((profile) => profile.id === servedPlan.profile);
  const planRow = phase.kind !== 'ready' || servedProfile === undefined ? undefined : `${alias ?? ''} · ${servedProfile.messages.planInUseLabel} · ${servedProfile.messages.manageUsageLabel}: ${servedProfile.usageUrl}`;
  const fullscreen = terminalState.screen === 'fullscreen';
  const panel = prompts.panel({ trustPath: phase.kind === 'trust' ? phase.path : undefined, ready: phase.kind === 'ready', panelRows: panelRowsCap(rows) });
  const shownPanel = fullscreen && panelRows === undefined ? undefined : panel;
  const inputShown = (phase.kind === 'ready' || phase.kind === 'unconnected') && shownPanel === undefined;
  const menuShown = inputShown && (invitationShown || completion !== undefined);
  const waiting = waitingText({ starting: phase.kind === 'starting', waiting: phase.kind === 'ready' ? transcript.waiting : undefined, busy: phase.kind === 'ready' && busy, reconnecting: phase.kind === 'ready' && reconnecting });
  const allocation = allocate(rows, {
    waiting: waiting === undefined ? 0 : 1,
    inputRows: inputRowsOf(editor, columns),
    menu: !menuShown ? 0 : phase.kind === 'ready' && invitationShown ? INVITATION_ROWS : COMPLETION_ROWS,
    subagents: transcript.subagents.length,
    footerSecond: !fullscreen || planRowFits(planRow, columns) ? (planRow === undefined ? 0 : 1) : 0,
    lines: inputShown ? attachments.length : 0,
    panel: shownPanel === undefined ? undefined : panelRows,
  });
  const transcriptWidth = fullscreen ? Math.max(1, columns - SCROLLBAR_COLUMNS) : columns;
  const view = useTranscriptView({
    store,
    terminal,
    fullscreen: fullscreen && !switching,
    width: transcriptWidth,
    allocation,
    copyOnSelect: props.copyOnSelect ?? SCREEN_SETTINGS.copyOnSelect,
    now,
    copy: (text) => backend.copyToClipboard(text),
    openLink: (url) => backend.openUrl(url, undefined, (message) => reportError(new Error(message))),
    reportError,
    keyFacts: () => ({ panelOpen: panel !== undefined, menuOpen: menuShown, inputEmpty: editorRef.current.text === '' }),
  });
  const footerFacts =
    phase.kind === 'ready' && overlay === undefined
      ? {
          mode,
          tokens: sessionTokens(transcript),
          contextPercent: contextPercentOf(transcript.contextTokens, capabilities?.contextWindow),
          imageInput,
          right: view.toast ?? newlineHintText(terminalState.newlineHint),
        }
      : undefined;

  return (
    <Screen
      view={switching || terminalState.tooSmall ? 'blank' : terminalState.screen}
      columns={columns}
      rows={rows}
      allocation={allocation}
      panel={panel}
      panelRows={panelRows}
      onPanelRows={setPanelRows}
      regions={{
        transcript: fullscreen ? (
          <TranscriptView window={view.window} height={allocation.viewport} width={transcriptWidth} entries={store.count()} following={view.position.following} selection={view.selection} />
        ) : (
          <HistoryView key={historyGeneration} store={store} source={view.source} />
        ),
        menu: !menuShown ? null : phase.kind === 'ready' && invitationShown && prompts.invitation !== undefined ? <InvitationMenu invitation={prompts.invitation} selected={prompts.invitationIndex} /> : completion === undefined ? null : <CompletionMenu completion={completion} />,
        waiting: waiting === undefined ? null : <WaitingRow text={waiting} />,
        lines: inputShown ? <AttachmentLines attachments={attachments} /> : null,
        input: inputShown ? <InputBox editor={editor} /> : null,
        footer: <Footer facts={footerFacts} unconnected={phase.kind === 'unconnected'} planRow={planRow} width={columns} rows={fullscreen ? allocation.footer : 2} />,
        subagents: <SubagentRows subagents={transcript.subagents} rows={fullscreen ? allocation.subagents : transcript.subagents.length} now={now} />,
      }}
    />
  );
}
