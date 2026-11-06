import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, usePaste, useStdout, useWindowSize } from 'ink';
import { agentReadiness, autoModeNotice, escapeTerminalBlock, escapeTerminalLine } from '@momonga/protocol';
import type { AliasCapabilities, ImageAttachment, MomongaModelEntry, PermissionMode, PermissionOption } from '@momonga/protocol';
import { cleanFailureMessage } from '@momonga/foundation';
import { currentField, currentRequest, decide, enterValue, leaveFields, withError } from '../elicit/flow.ts';
import type { ElicitationDecision, ElicitationFlow } from '../elicit/flow.ts';
import type { RunEventFrame } from '../client/runtime-client.ts';
import type { RunView, SessionView } from '../client/views.ts';
import { describeAttachment, pastedImagePaths } from '../images.ts';
import { describeFailure } from '../failure.ts';
import { readinessNoticeOf } from '../readiness.ts';
import { describeDenial } from '../policy-messages.ts';
import { describeEnd } from '../run/headless.ts';
import type { StartRunOptions, TuiBackend } from './backend.ts';
import { createBackgroundTasks } from './background-tasks.ts';
import type { BackgroundTasks } from './background-tasks.ts';
import { autoNoticeDue } from './notices.ts';
import type { AutoNoticePair } from './notices.ts';
import { DEFAULT_SLASH_COMMANDS } from './commands/index.ts';
import { StartupScreen } from './startup.tsx';
import type { StartupConfig } from './startup.tsx';
import { skillCommands } from './commands/skills.ts';
import { clipDiff, diffOfToolInput, maxDiffLines } from './diff.ts';
import type { DiffLine } from './diff.ts';
import { applyKey, characterEndAfter, emptyEditor } from './editor.ts';
import type { EditorState } from './editor.ts';
import { createSlashRegistry, parseSlash, slashCompletion } from './slash.ts';
import type { AutoModePort, ShellPort, SlashCommand, SlashRegistry } from './slash.ts';
import { appendEntry, initialTranscript, nextMode, reduceChildEvent, reduceEvent, settledCount, withElicitationFlow } from './transcript.ts';
import type { Entry, PendingApproval, PendingElicitation, Transcript } from './transcript.ts';

export type TuiOutcome = { error?: Error };

type StaticItem = { kind: 'banner' } | { kind: 'entry'; entry: Entry };

type Attachment = { file: string; image: ImageAttachment };

export type AppProps = {
  backend: TuiBackend;
  initialMode: PermissionMode | undefined;
  initialPrompt?: string;
  initialImages?: readonly string[];
  initialSkill?: string;
  startup?: StartupConfig;
  slash?: SlashRegistry;
  tasks?: BackgroundTasks;
  autoMode?: AutoModePort;
  shell?: ShellPort;
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

type Phase = { kind: 'starting' } | { kind: 'trust'; path: string } | { kind: 'ready' };

type TranscriptAction =
  | { kind: 'event'; frame: RunEventFrame }
  | { kind: 'child-event'; frame: RunEventFrame; agent: string }
  | { kind: 'append'; entry: Entry }
  | { kind: 'elicitation-flow'; flow: ElicitationFlow; submitted: boolean }
  | { kind: 'run-started'; runId: string }
  | { kind: 'reset' };

const transcriptReducer = (state: Transcript, action: TranscriptAction): Transcript => {
  switch (action.kind) {
    case 'event':
      return reduceEvent(state, action.frame.data);
    case 'child-event':
      return reduceChildEvent(state, action.frame.data, action.agent);
    case 'append':
      return appendEntry(state, action.entry);
    case 'elicitation-flow':
      return withElicitationFlow(state, action.flow, action.submitted);
    case 'run-started':
      return { ...state, runId: action.runId, runStatus: 'QUEUED' };
    case 'reset':
      return initialTranscript;
  }
};

const CLEAR_SCREEN = '\u001b[2J\u001b[3J\u001b[H';

const TRUST_CHOICES = [
  { key: '1', decision: 'trusted', label: 'Yes, I trust this folder' },
  { key: '2', decision: 'untrusted', label: 'No, continue without its project settings' },
] as const;

const formatTokens = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));

const toolMark = (status: Extract<Entry, { kind: 'tool' }>['status']): string => {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'unknown':
      return '?';
    case 'running':
      return '…';
    case 'awaiting_approval':
      return '!';
    case 'requested':
      return '·';
  }
};

const diffColor = (line: DiffLine): string | undefined => {
  switch (line.kind) {
    case 'added':
      return 'green';
    case 'removed':
      return 'red';
    case 'header':
      return 'cyan';
    case 'context':
      return undefined;
  }
};

const diffPrefix = (line: DiffLine): string => {
  switch (line.kind) {
    case 'added':
      return '+ ';
    case 'removed':
      return '- ';
    case 'header':
      return '';
    case 'context':
      return '  ';
  }
};

const colorProps = (color: string | undefined): { color?: string } => (color === undefined ? {} : { color });

function DiffView({ lines, max }: { lines: readonly DiffLine[]; max: number }) {
  const clipped = clipDiff(lines, max);
  return (
    <Box flexDirection="column">
      {clipped.lines.map((line, index) => (
        <Text key={index} {...colorProps(diffColor(line))}>
          {diffPrefix(line)}
          {shown(line.text)}
        </Text>
      ))}
      {clipped.omitted > 0 ? <Text dimColor>… {clipped.omitted} more lines</Text> : null}
    </Box>
  );
}

const shown = (text: string): string => escapeTerminalBlock(text.replaceAll('\r\n', '\n'));

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'user':
      return <Text color="cyan">{`> ${entry.text}`}</Text>;
    case 'assistant':
      return <Text>{shown(entry.text)}</Text>;
    case 'tool':
      return (
        <Box flexDirection="column">
          <Text>
            {toolMark(entry.status)} {shown(entry.title)}
          </Text>
          {entry.status === 'failed' && entry.denial !== undefined ? <Text color="red">{escapeTerminalLine(describeDenial(entry.denial))}</Text> : null}
          {entry.status === 'failed' && entry.denial === undefined && entry.output !== undefined ? (
            <Text color="red">{shown(entry.output.split('\n').slice(0, 3).join('\n'))}</Text>
          ) : null}
          {entry.status === 'unknown' && entry.output !== undefined ? <Text color="yellow">{shown(entry.output)}</Text> : null}
        </Box>
      );
    case 'plan':
      return (
        <Box flexDirection="column">
          {entry.entries.map((item, index) => (
            <Text key={index}>{shown(`${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]'} ${item.content}`)}</Text>
          ))}
        </Box>
      );
    case 'notice':
      return <Text color={entry.level === 'error' ? 'red' : entry.level === 'warning' ? 'yellow' : 'gray'}>{shown(entry.text)}</Text>;
    case 'info':
      return <Text dimColor>{shown(entry.text)}</Text>;
  }
}

function ApprovalPrompt({ approval, tool, selected, workingDirectory }: { approval: PendingApproval; tool: Extract<Entry, { kind: 'tool' }> | undefined; selected: number; workingDirectory: string }) {
  const { rows } = useWindowSize();
  const diff = tool === undefined ? undefined : diffOfToolInput(tool.name, tool.rawInput, workingDirectory);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{shown(`Permission requested: ${tool?.title ?? approval.callId}`)}</Text>
      <Text>{shown(approval.reason)}</Text>
      {diff === undefined ? null : <DiffView lines={diff} max={maxDiffLines(rows, approval.options.length)} />}
      {approval.options.map((option: PermissionOption, index) => (
        <Text key={option.optionId} inverse={index === selected}>{shown(`${index + 1}. ${option.name}`)}</Text>
      ))}
      <Text dimColor>1-{approval.options.length} or up/down and enter to choose, esc to cancel the run</Text>
    </Box>
  );
}

function InputBox({ editor }: { editor: EditorState }) {
  const before = editor.text.slice(0, editor.cursor);
  const atCursor = editor.text.slice(editor.cursor, characterEndAfter(editor.text, editor.cursor));
  const cursorChar = atCursor === '' || atCursor === '\n' ? ' ' : atCursor;
  const after = editor.text.slice(editor.cursor + (atCursor === '' || atCursor === '\n' ? 0 : atCursor.length));
  const lines = `${before}\u0000${cursorChar}\u0001${after}`.split('\n');
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {lines.map((line, index) => {
        const open = line.indexOf('\u0000');
        const close = line.indexOf('\u0001');
        const prefix = index === 0 ? '> ' : '  ';
        if (open < 0 || close < 0) return <Text key={index}>{`${prefix}${line}`}</Text>;
        return (
          <Text key={index}>
            {prefix}
            {line.slice(0, open)}
            <Text inverse>{line.slice(open + 1, close)}</Text>
            {line.slice(close + 1)}
          </Text>
        );
      })}
    </Box>
  );
}

export const decisionChoices = (flow: ElicitationFlow): readonly { decision: ElicitationDecision; label: string }[] => {
  const accept = currentRequest(flow).mode === 'url' ? 'Open the URL in the browser and accept' : 'Submit';
  return [
    { decision: 'accept', label: accept },
    { decision: 'decline', label: 'Decline' },
    { decision: 'cancel', label: 'Cancel' },
  ];
};

function ElicitationPrompt({ elicitation, title, editor, selected }: { elicitation: PendingElicitation; title: string; editor: EditorState; selected: number }) {
  const { flow } = elicitation;
  const request = currentRequest(flow);
  const field = currentField(flow);
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{shown(`MCP server ${elicitation.server} asks for input (${title}) ${flow.index + 1}/${flow.requests.length}`)}</Text>
        <Text>{shown(request.message)}</Text>
        {request.mode === 'url' ? <Text>{shown(`URL: ${request.url}`)}</Text> : null}
        {flow.stage === 'fields' && field !== undefined ? (
          <Box flexDirection="column">
            <Text bold>{shown(`${field.title} (${field.name}, ${field.kind}${field.required ? ', required' : ', optional: leave empty to skip'})`)}</Text>
            {field.description === undefined ? null : <Text dimColor>{shown(field.description)}</Text>}
            {field.options.map((option, index) => (
              <Text key={option.value}>{shown(`  ${index + 1}. ${option.label}`)}</Text>
            ))}
          </Box>
        ) : null}
        {flow.stage === 'decision'
          ? decisionChoices(flow).map((choice, index) => (
              <Text key={choice.decision} inverse={index === selected}>{`${index + 1}. ${choice.label}`}</Text>
            ))
          : null}
        {flow.error === undefined ? null : <Text color="red">{shown(flow.error)}</Text>}
        {elicitation.submitted ? <Text dimColor>sending the answer…</Text> : null}
        <Text dimColor>
          {flow.stage === 'fields'
            ? 'enter to confirm the value, esc to decline or cancel instead'
            : '1-3 or up/down and enter to choose, esc to cancel the run'}
        </Text>
      </Box>
      {flow.stage === 'fields' ? <InputBox editor={editor} /> : null}
    </Box>
  );
}

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export function App(props: AppProps) {
  const { backend, onExit } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const baseSlash = props.slash ?? createSlashRegistry(DEFAULT_SLASH_COMMANDS);
  const ownTasks = useRef<BackgroundTasks>(props.tasks ?? createBackgroundTasks());
  const tasks = props.tasks ?? ownTasks.current;
  const lastAutoNotice = useRef<AutoNoticePair | undefined>(undefined);
  const [skillSlash, setSkillSlash] = useState<readonly SlashCommand[]>([]);
  const slash = createSlashRegistry([...baseSlash.list(), ...skillSlash]);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript);
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  const [mode, setModeState] = useState<PermissionMode>(props.initialMode ?? 'default');
  const [bypassAllowed, setBypassAllowed] = useState(false);
  const [autoAvailable, setAutoAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approvalIndex, setApprovalIndexState] = useState(0);
  const [model, setModel] = useState<MomongaModelEntry | undefined>(undefined);
  const [alias, setAlias] = useState<string | undefined>(undefined);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const capabilities: AliasCapabilities | undefined = model?.capabilities;
  const [attachments, setAttachmentsState] = useState<readonly Attachment[]>([]);
  const [elicitEditor, setElicitEditor] = useState<EditorState>(emptyEditor());
  const [epoch, setEpoch] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const nextHistory = useRef<'inherit' | 'fresh'>('inherit');
  const initialPromptSent = useRef(false);
  const exiting = useRef(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<EditorState>(editor);
  const approvalIndexRef = useRef(0);
  const attachmentsRef = useRef<readonly Attachment[]>([]);
  const elicitEditorRef = useRef<EditorState>(elicitEditor);
  const flowRef = useRef<{ inputId: string; flow: ElicitationFlow } | undefined>(undefined);

  const setApprovalIndex = (index: number): void => {
    approvalIndexRef.current = index;
    setApprovalIndexState(index);
  };

  const promptKey = transcript.approval?.approvalId ?? transcript.elicitation?.inputId;
  const [selectionOwner, setSelectionOwner] = useState(promptKey);
  if (selectionOwner !== promptKey) {
    setSelectionOwner(promptKey);
    setApprovalIndex(0);
  }

  const setAttachments = (next: readonly Attachment[]): void => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  };

  const replaceElicitEditor = (next: EditorState): void => {
    elicitEditorRef.current = next;
    setElicitEditor(next);
  };

  const replaceEditor = (next: EditorState): void => {
    editorRef.current = next;
    setEditor(next);
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
    dispatch({ kind: 'append', entry: { kind: 'info', text } });
  };

  const reportError = (error: unknown): void => {
    dispatch({ kind: 'append', entry: { kind: 'notice', level: 'error', text: describeFailure(error) } });
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
    if (text !== undefined) dispatch({ kind: 'append', entry: { kind: 'notice', level: 'warning', text } });
  };

  const openSession = async (): Promise<void> => {
    const session = await backend.openSession();
    setModeState(session.permissionMode);
    showAutoNotice(session);
    setAlias(session.modelAlias);
    setBypassAllowed(session.bypassAllowed);
    setAutoAvailable(await backend.autoModeAvailable());
    replaceEditor(emptyEditor(await backend.loadHistory()));
    setPhase({ kind: 'ready' });
    void backend.model().then(showModel, (error: unknown) => {
      dispatch({ kind: 'append', entry: { kind: 'notice', level: 'warning', text: `model information unavailable: ${errorOf(error).message}` } });
    });
    void backend.startupNotices().then(
      (found) => setNotices((previous) => [...previous, ...found]),
      (error: unknown) => {
        dispatch({ kind: 'append', entry: { kind: 'notice', level: 'warning', text: `startup notices unavailable: ${errorOf(error).message}` } });
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
        dispatch({ kind: 'append', entry: { kind: 'notice', level: 'warning', text: `skills unavailable: ${errorOf(error).message}` } });
      },
    );
  };

  const boot = useEffectEvent(async (): Promise<void> => {
    try {
      const trust = await backend.boot();
      if (trust.decision === null) {
        setPhase({ kind: 'trust', path: trust.path });
        return;
      }
      await openSession();
    } catch (error) {
      fail(error);
    }
  });

  useEffect(() => {
    void boot();
  }, [backend]);

  const runPrompt = async (text: string, options: { skill?: string } = {}): Promise<void> => {
    setBusy(true);
    const sent = attachmentsRef.current;
    setAttachments([]);
    dispatch({ kind: 'append', entry: { kind: 'user', text } });
    for (const attachment of sent) note(`attached ${describeAttachment(attachment.file, attachment.image)}`);
    try {
      const history = nextHistory.current;
      nextHistory.current = 'inherit';
      const runOptions: StartRunOptions = { ...options, ...(sent.length === 0 ? {} : { images: sent.map((attachment) => attachment.image) }) };
      const started = await backend.startRun(text, history, runOptions);
      runIdRef.current = started.id;
      dispatch({ kind: 'run-started', runId: started.id });
      const run: RunView = await backend.follow(started.id, {
        onEvent: (frame) => {
          setReconnecting(false);
          dispatch({ kind: 'event', frame });
        },
        onChildEvent: (frame, agent) => {
          setReconnecting(false);
          dispatch({ kind: 'child-event', frame, agent });
        },
        onReconnecting: () => setReconnecting(true),
      });
      setReconnecting(false);
      if (run.status !== 'COMPLETED') dispatch({ kind: 'append', entry: { kind: 'notice', level: run.status === 'CANCELLED' ? 'info' : 'error', text: describeEnd(run) } });
    } catch (error) {
      if (!exiting.current) reportError(error);
    } finally {
      runIdRef.current = undefined;
      setBusy(false);
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
    if (alias === undefined) throw new Error('a slash command ran before the session was open');
    await command.run(parsed.args, {
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
        nextHistory.current = 'fresh';
        dispatch({ kind: 'reset' });
        stdout.write(CLEAR_SCREEN);
        setEpoch((value) => value + 1);
      },
      exit: () => finish({}),
      background: (label, work) => {
        note(`${label}: running (esc cancels)`);
        return tasks.run(work);
      },
      autoMode: props.autoMode ?? unavailableAutoMode,
      shell: props.shell ?? unavailableShell,
      setMode: async (chosen) => {
        const session = await backend.setMode(chosen);
        setModeState(session.permissionMode);
        note(`permission mode: ${session.permissionMode}`);
        showAutoNotice(session);
      },
      setModel: async (chosen) => {
        const previous = alias;
        const session = await backend.setModel(chosen);
        setAlias(session.modelAlias);
        note(
          busy
            ? `model: ${session.modelAlias}; the running task keeps ${previous}, the next task uses ${session.modelAlias}`
            : `model: ${session.modelAlias}; applies from the next task`,
        );
        void backend.model().then(showModel, (error: unknown) => {
          dispatch({ kind: 'append', entry: { kind: 'notice', level: 'warning', text: `model information unavailable: ${errorOf(error).message}` } });
        });
      },
    });
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

  const cancelNewest = (): void => {
    const runId = runIdRef.current;
    if (runId === undefined) {
      tasks.abortNewest();
      return;
    }
    backend.cancel(runId).catch(reportError);
  };

  const resolveApproval = (approval: PendingApproval, option: PermissionOption | undefined): void => {
    if (option === undefined) return;
    backend.resolveApproval(approval.approvalId, option.optionId).catch(reportError);
  };

  const attach = async (files: readonly string[]): Promise<void> => {
    const added: Attachment[] = [];
    for (const file of files) added.push({ file, image: await backend.readImage(file) });
    setAttachments([...attachmentsRef.current, ...added]);
  };

  const imageInput = capabilities?.imageInput === true;

  usePaste(
    (text) => {
      const paths = imageInput ? pastedImagePaths(text) : undefined;
      if (paths !== undefined) {
        attach(paths).catch(reportError);
        return;
      }
      if (transcript.elicitation !== undefined) {
        if (transcript.elicitation.flow.stage === 'fields') replaceElicitEditor(applyKey(elicitEditorRef.current, { input: text }).state);
        return;
      }
      replaceEditor(applyKey(editorRef.current, { input: text }).state);
    },
    { isActive: phase.kind === 'ready' && transcript.approval === undefined },
  );

  const flowOf = (pending: PendingElicitation): ElicitationFlow =>
    flowRef.current?.inputId === pending.inputId ? flowRef.current.flow : pending.flow;

  const applyFlow = (pending: PendingElicitation, flow: ElicitationFlow, submitted = false): void => {
    flowRef.current = { inputId: pending.inputId, flow };
    setApprovalIndex(0);
    dispatch({ kind: 'elicitation-flow', flow, submitted });
  };

  const proceedFlow = (pending: PendingElicitation, flow: ElicitationFlow): void => {
    if (!flow.complete) {
      applyFlow(pending, flow);
      return;
    }
    applyFlow(pending, flow, true);
    for (const notice of flow.notices) {
      dispatch({ kind: 'append', entry: { kind: 'notice', level: 'warning', text: escapeTerminalLine(`MCP server ${cleanFailureMessage(pending.server)}: ${notice}`) } });
    }
    backend.resolveElicitation(pending.inputId, flow.answers).catch((error: unknown) => {
      applyFlow(pending, withError({ ...flow, complete: false, stage: 'decision' }, errorOf(error).message));
    });
  };

  const decideFlow = (pending: PendingElicitation, decision: ElicitationDecision | undefined): void => {
    if (decision === undefined) return;
    const flow = flowOf(pending);
    const request = currentRequest(flow);
    if (decision === 'accept' && request.mode === 'url') {
      decide(flow, decision).then(
        (next) =>
          backend.openUrl(new URL(request.url)).then(
            () => proceedFlow(pending, next),
            (error: unknown) => applyFlow(pending, withError(flow, `could not open the URL: ${errorOf(error).message}`)),
          ),
        fail,
      );
      return;
    }
    decide(flow, decision).then((next) => proceedFlow(pending, next), fail);
  };

  const elicitationKey = (pending: PendingElicitation, input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): void => {
    if (key.ctrl && input === 'c') {
      cancelNewest();
      return;
    }
    if (pending.submitted) return;
    const flow = flowOf(pending);
    if (flow.stage === 'decision') {
      const choices = decisionChoices(flow);
      if (key.escape) cancelNewest();
      else if (key.upArrow) setApprovalIndex((approvalIndexRef.current + choices.length - 1) % choices.length);
      else if (key.downArrow) setApprovalIndex((approvalIndexRef.current + 1) % choices.length);
      else if (key.return) decideFlow(pending, choices[approvalIndexRef.current]?.decision);
      else if (/^[1-9]$/.test(input)) decideFlow(pending, choices[Number(input) - 1]?.decision);
      return;
    }
    if (key.escape) {
      applyFlow(pending, leaveFields(flow));
      return;
    }
    if (key.return && elicitEditorRef.current.text === '') {
      enterValue(flow, '').then((next) => proceedFlow(pending, next), fail);
      return;
    }
    const outcome = applyKey(elicitEditorRef.current, { ...key, input });
    replaceElicitEditor(outcome.state);
    if (outcome.submit !== undefined) enterValue(flow, outcome.submit).then((next) => proceedFlow(pending, next), fail);
  };

  const cycleMode = (): void => {
    backend
      .setMode(nextMode({ current: mode, bypassAllowed, autoAvailable }))
      .then((session) => {
        setModeState(session.permissionMode);
        showAutoNotice(session);
      }, reportError);
  };

  const decideTrust = (decision: 'trusted' | 'untrusted'): void => {
    const decide = async (): Promise<void> => {
      await backend.decideTrust(decision);
      await openSession();
    };
    decide().catch(fail);
  };

  useInput((input, key) => {
    if (phase.kind === 'starting') {
      if (key.ctrl && input === 'c') finish({});
      return;
    }
    if (phase.kind === 'trust') {
      if (key.escape || (key.ctrl && input === 'c')) {
        finish({});
        return;
      }
      const choice = TRUST_CHOICES.find((candidate) => candidate.key === input);
      if (choice !== undefined) decideTrust(choice.decision);
      return;
    }
    if (key.tab && key.shift) {
      cycleMode();
      return;
    }
    if (transcript.elicitation !== undefined) {
      elicitationKey(transcript.elicitation, input, key);
      return;
    }
    const approval = transcript.approval;
    if (approval !== undefined) {
      if (key.escape || (key.ctrl && input === 'c')) {
        cancelNewest();
        return;
      }
      if (key.upArrow) setApprovalIndex((approvalIndexRef.current + approval.options.length - 1) % approval.options.length);
      else if (key.downArrow) setApprovalIndex((approvalIndexRef.current + 1) % approval.options.length);
      else if (key.return) resolveApproval(approval, approval.options[approvalIndexRef.current]);
      else if (/^[1-9]$/.test(input)) resolveApproval(approval, approval.options[Number(input) - 1]);
      return;
    }
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
    replaceEditor(outcome.state);
    if (outcome.submit !== undefined) {
      backend.recordHistory(outcome.submit).catch(reportError);
      submitSafely(outcome.submit);
    }
  });

  const settled = settledCount(transcript.entries);
  const pendingTool = transcript.approval === undefined ? undefined : transcript.entries.find((entry): entry is Extract<Entry, { kind: 'tool' }> => entry.kind === 'tool' && entry.callId === transcript.approval?.callId);
  const contextWindow = capabilities?.contextWindow;
  const contextPercent = contextWindow === undefined || transcript.contextTokens === undefined ? undefined : Math.round((transcript.contextTokens / contextWindow) * 100);
  const pendingTitle = transcript.elicitation === undefined ? '' : (transcript.entries.find((entry): entry is Extract<Entry, { kind: 'tool' }> => entry.kind === 'tool' && entry.callId === transcript.elicitation?.callId)?.title ?? transcript.elicitation.callId);
  const completion = phase.kind === 'ready' ? slashCompletion(editor.text, slash.list()) : undefined;

  const banner =
    props.startup === undefined || alias === undefined ? null : (
      <StartupScreen config={props.startup} model={{ alias, targets: model?.targets }} mode={mode} cwd={backend.cwd} notices={notices} />
    );
  const staticItems: StaticItem[] = [
    ...(banner !== null && transcript.entries.length > 0 ? [{ kind: 'banner' } as const] : []),
    ...transcript.entries.slice(0, settled).map((entry): StaticItem => ({ kind: 'entry', entry })),
  ];

  return (
    <Box flexDirection="column">
      <Static key={epoch} items={staticItems}>
        {(item, index) => (
          <Box key={index}>{item.kind === 'banner' ? banner : <EntryView entry={item.entry} />}</Box>
        )}
      </Static>
      {transcript.entries.slice(settled).map((entry, index) => (
        <EntryView key={index} entry={entry} />
      ))}
      {phase.kind === 'ready' && transcript.entries.length === 0 ? banner : null}
      {phase.kind === 'starting' ? <Text dimColor>starting the momonga daemon…</Text> : null}
      {phase.kind === 'trust' ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{`Do you trust the files in ${phase.path}?`}</Text>
          <Text>Project settings and MCP servers in this folder are only loaded when you trust it.</Text>
          {TRUST_CHOICES.map((choice) => (
            <Text key={choice.key}>{`${choice.key}. ${choice.label}`}</Text>
          ))}
          <Text dimColor>esc to exit</Text>
        </Box>
      ) : null}
      {phase.kind === 'ready' && transcript.approval !== undefined ? <ApprovalPrompt approval={transcript.approval} tool={pendingTool} selected={approvalIndex} workingDirectory={backend.cwd} /> : null}
      {phase.kind === 'ready' && transcript.elicitation !== undefined ? (
        <ElicitationPrompt elicitation={transcript.elicitation} title={pendingTitle} editor={elicitEditor} selected={approvalIndex} />
      ) : null}
      {phase.kind === 'ready' && transcript.approval === undefined && transcript.elicitation === undefined ? (
        <Box flexDirection="column">
          {attachments.map((attachment, index) => (
            <Text key={index} dimColor>{`attached ${describeAttachment(attachment.file, attachment.image)} (backspace on an empty input removes the last)`}</Text>
          ))}
          <InputBox editor={editor} />
          {completion === undefined ? null : <Text dimColor>{completion.names.map((name) => `/${name}`).join('  ')} (tab completes)</Text>}
        </Box>
      ) : null}
      {phase.kind === 'ready' ? (
        <Text dimColor>
          {`mode: ${mode} (shift+tab) · tokens: ${formatTokens(transcript.usage.totalTokens)}${transcript.waiting === undefined ? '' : ` · waiting for ${transcript.waiting}`}${contextPercent === undefined ? '' : ` · context: ${contextPercent}%`}${imageInput ? ' · image input: paste a file path' : ''}${busy ? ' · working (esc to cancel)' : ''}${reconnecting ? ' · reconnecting…' : ''}`}
        </Text>
      ) : null}
    </Box>
  );
}
