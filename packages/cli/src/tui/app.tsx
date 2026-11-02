import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import type { PermissionMode, PermissionOption } from '@momonga/protocol';
import type { RunEventFrame } from '../client/runtime-client.ts';
import type { RunView } from '../client/views.ts';
import { describeEnd } from '../run/headless.ts';
import type { TuiBackend } from './backend.ts';
import { clipDiff, diffOfToolInput } from './diff.ts';
import type { DiffLine } from './diff.ts';
import { applyKey, emptyEditor } from './editor.ts';
import type { EditorState } from './editor.ts';
import { createSlashRegistry, BUILTIN_SLASH_COMMANDS, parseSlash } from './slash.ts';
import type { SlashRegistry } from './slash.ts';
import { appendEntry, initialTranscript, nextMode, reduceEvent, settledCount } from './transcript.ts';
import type { Entry, PendingApproval, Transcript } from './transcript.ts';

export type TuiOutcome = { error?: Error };

export type AppProps = {
  backend: TuiBackend;
  initialMode: PermissionMode | undefined;
  initialPrompt?: string;
  slash?: SlashRegistry;
  onExit(outcome: TuiOutcome): void;
};

type Phase = { kind: 'starting' } | { kind: 'trust'; path: string } | { kind: 'ready' };

type TranscriptAction =
  | { kind: 'event'; frame: RunEventFrame }
  | { kind: 'append'; entry: Entry }
  | { kind: 'run-started'; runId: string }
  | { kind: 'reset' };

const transcriptReducer = (state: Transcript, action: TranscriptAction): Transcript => {
  switch (action.kind) {
    case 'event':
      return reduceEvent(state, action.frame.data);
    case 'append':
      return appendEntry(state, action.entry);
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

function DiffView({ lines }: { lines: readonly DiffLine[] }) {
  const clipped = clipDiff(lines);
  return (
    <Box flexDirection="column">
      {clipped.lines.map((line, index) => (
        <Text key={index} {...colorProps(diffColor(line))}>
          {diffPrefix(line)}
          {line.text}
        </Text>
      ))}
      {clipped.omitted > 0 ? <Text dimColor>… {clipped.omitted} more lines</Text> : null}
    </Box>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'user':
      return <Text color="cyan">{`> ${entry.text}`}</Text>;
    case 'assistant':
      return <Text>{entry.text}</Text>;
    case 'tool':
      return (
        <Box flexDirection="column">
          <Text>
            {toolMark(entry.status)} {entry.title}
          </Text>
          {entry.status === 'failed' && entry.output !== undefined ? <Text color="red">{entry.output.split('\n').slice(0, 3).join('\n')}</Text> : null}
          {entry.status === 'unknown' && entry.output !== undefined ? <Text color="yellow">{entry.output}</Text> : null}
        </Box>
      );
    case 'plan':
      return (
        <Box flexDirection="column">
          {entry.entries.map((item, index) => (
            <Text key={index}>{`${item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]'} ${item.content}`}</Text>
          ))}
        </Box>
      );
    case 'notice':
      return <Text color={entry.level === 'error' ? 'red' : entry.level === 'warning' ? 'yellow' : 'gray'}>{entry.text}</Text>;
    case 'info':
      return <Text dimColor>{entry.text}</Text>;
  }
}

function ApprovalPrompt({ approval, tool, selected }: { approval: PendingApproval; tool: Extract<Entry, { kind: 'tool' }> | undefined; selected: number }) {
  const diff = tool === undefined ? undefined : diffOfToolInput(tool.name, tool.rawInput);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{`Permission requested: ${tool?.title ?? approval.callId}`}</Text>
      {diff === undefined ? null : <DiffView lines={diff} />}
      {approval.options.map((option: PermissionOption, index) => (
        <Text key={option.optionId} inverse={index === selected}>{`${index + 1}. ${option.name}`}</Text>
      ))}
      <Text dimColor>1-{approval.options.length} or up/down and enter to choose, esc to cancel the run</Text>
    </Box>
  );
}

function InputBox({ editor }: { editor: EditorState }) {
  const before = editor.text.slice(0, editor.cursor);
  const atCursor = editor.text[editor.cursor];
  const cursorChar = atCursor === undefined || atCursor === '\n' ? ' ' : atCursor;
  const after = editor.text.slice(editor.cursor + (atCursor === undefined || atCursor === '\n' ? 0 : 1));
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

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export function App(props: AppProps) {
  const { backend, onExit } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const slash = props.slash ?? createSlashRegistry(BUILTIN_SLASH_COMMANDS);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript);
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  const [mode, setModeState] = useState<PermissionMode>(props.initialMode ?? 'default');
  const [bypassAllowed, setBypassAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approvalIndex, setApprovalIndexState] = useState(0);
  const [contextWindow, setContextWindow] = useState<number | undefined>(undefined);
  const [epoch, setEpoch] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const nextHistory = useRef<'inherit' | 'fresh'>('inherit');
  const initialPromptSent = useRef(false);
  const exiting = useRef(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const editorRef = useRef<EditorState>(editor);
  const approvalIndexRef = useRef(0);

  const setApprovalIndex = (index: number): void => {
    approvalIndexRef.current = index;
    setApprovalIndexState(index);
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
    dispatch({ kind: 'append', entry: { kind: 'notice', level: 'error', text: errorOf(error).message } });
  };

  const openSession = async (): Promise<void> => {
    const session = await backend.openSession();
    setModeState(session.permissionMode);
    setBypassAllowed(session.bypassAllowed);
    replaceEditor(emptyEditor(await backend.loadHistory()));
    setPhase({ kind: 'ready' });
    void backend.contextWindow().then(setContextWindow, (error: unknown) => {
      dispatch({ kind: 'append', entry: { kind: 'notice', level: 'warning', text: `context window unavailable: ${errorOf(error).message}` } });
    });
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

  const runPrompt = async (text: string): Promise<void> => {
    setBusy(true);
    dispatch({ kind: 'append', entry: { kind: 'user', text } });
    try {
      const history = nextHistory.current;
      nextHistory.current = 'inherit';
      const started = await backend.startRun(text, history);
      runIdRef.current = started.id;
      dispatch({ kind: 'run-started', runId: started.id });
      const run: RunView = await backend.follow(started.id, {
        onEvent: (frame) => {
          setReconnecting(false);
          dispatch({ kind: 'event', frame });
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
    await command.run(parsed.args, {
      mode,
      bypassAllowed,
      commands: slash.list(),
      info: note,
      clear: () => {
        nextHistory.current = 'fresh';
        dispatch({ kind: 'reset' });
        stdout.write(CLEAR_SCREEN);
        setEpoch((value) => value + 1);
      },
      exit: () => finish({}),
      setMode: async (chosen) => {
        const session = await backend.setMode(chosen);
        setModeState(session.permissionMode);
        note(`permission mode: ${session.permissionMode}`);
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
    if (props.initialPrompt === undefined || initialPromptSent.current) return;
    initialPromptSent.current = true;
    submit(props.initialPrompt).catch(reportError);
  });

  useEffect(() => {
    if (phase.kind === 'ready') sendInitialPrompt();
  }, [phase.kind]);

  const cancelRun = (): void => {
    const runId = runIdRef.current;
    if (runId === undefined) return;
    backend.cancel(runId).catch(reportError);
  };

  const resolveApproval = (approval: PendingApproval, option: PermissionOption | undefined): void => {
    if (option === undefined) return;
    backend.resolveApproval(approval.approvalId, option.optionId).catch(reportError);
  };

  const cycleMode = (): void => {
    backend
      .setMode(nextMode({ current: mode, bypassAllowed }))
      .then((session) => setModeState(session.permissionMode), reportError);
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
    const approval = transcript.approval;
    if (approval !== undefined) {
      if (key.escape || (key.ctrl && input === 'c')) {
        cancelRun();
        return;
      }
      if (key.upArrow) setApprovalIndex((approvalIndexRef.current + approval.options.length - 1) % approval.options.length);
      else if (key.downArrow) setApprovalIndex((approvalIndexRef.current + 1) % approval.options.length);
      else if (key.return) resolveApproval(approval, approval.options[approvalIndexRef.current]);
      else if (/^[1-9]$/.test(input)) resolveApproval(approval, approval.options[Number(input) - 1]);
      return;
    }
    if (key.escape) {
      cancelRun();
      return;
    }
    if (key.ctrl && input === 'c') {
      if (busy) cancelRun();
      else if (editorRef.current.text === '') finish({});
      else replaceEditor(emptyEditor(editorRef.current.history));
      return;
    }
    if (key.ctrl && input === 'd' && editorRef.current.text === '') {
      finish({});
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
  const contextPercent = contextWindow === undefined || transcript.contextTokens === undefined ? undefined : Math.round((transcript.contextTokens / contextWindow) * 100);

  return (
    <Box flexDirection="column">
      <Static key={epoch} items={transcript.entries.slice(0, settled)}>
        {(entry, index) => (
          <Box key={index}>
            <EntryView entry={entry} />
          </Box>
        )}
      </Static>
      {transcript.entries.slice(settled).map((entry, index) => (
        <EntryView key={index} entry={entry} />
      ))}
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
      {phase.kind === 'ready' && transcript.approval !== undefined ? <ApprovalPrompt approval={transcript.approval} tool={pendingTool} selected={approvalIndex} /> : null}
      {phase.kind === 'ready' && transcript.approval === undefined ? <InputBox editor={editor} /> : null}
      {phase.kind === 'ready' ? (
        <Text dimColor>
          {`mode: ${mode} (shift+tab) · tokens: ${formatTokens(transcript.usage.totalTokens)}${contextPercent === undefined ? '' : ` · context: ${contextPercent}%`}${busy ? ' · working (esc to cancel)' : ''}${reconnecting ? ' · reconnecting…' : ''}`}
        </Text>
      ) : null}
    </Box>
  );
}
