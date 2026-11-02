import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { emptyWorkingFacts, findDanglingOutput, findUnpairedCalls, inheritedWorkingFacts } from '@momonga/protocol';
import { hasConsistentSeqs } from './seqs.ts';
import type { InputItem, PermissionMode, RunEventPayload, RunState, StopReason, TerminalStatus } from '@momonga/protocol';

export type InheritedPayload = Extract<RunEventPayload, { type: 'context.inherited' }>;

export type InheritanceOutcome = { status: TerminalStatus; stopReason?: StopReason; errorCode?: string; carriedSkills?: readonly string[] };

export type InheritanceKind = { kind: 'final'; currentMode: PermissionMode } | { kind: 'intermediate' };

export type InheritanceErrorCode = 'previous_run_unreadable' | 'previous_run_inconsistent';

export class InheritanceError extends Error {
  readonly code: InheritanceErrorCode;

  constructor(code: InheritanceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InheritanceError';
    this.code = code;
  }
}

type HistoryEntry = RunState['history'][number];
type MarkerKind = InheritedPayload['markers'][number]['kind'];

const CLOSURE_TEXT = {
  cancelled: 'Not run: the user interrupted the previous request before this tool call ran.',
  approvalTimeout: 'Not run: approval for this tool call was not given in time.',
  loop: 'Not run: the previous request was stopped because the same tool call kept repeating.',
  timeout: 'Not run: the previous request ran out of time before this tool call ran.',
  failed: 'Not run: the previous request ended with an error before this tool call ran.',
  other: 'Not run: the previous request was stopped before this tool call ran.',
} as const;

const MARKER_TEXT = {
  userInterrupted: '[The user interrupted the previous request before it was finished.]',
  ended: '[The previous request ended before it was finished.]',
  unprocessed: '[The previous request was never processed: it timed out while waiting in the queue.]',
  dropped: '[A previous message was too large to process and was dropped.]',
} as const;

const MODE_RULE: Record<PermissionMode, string> = {
  default:
    "File changes and commands need the user's approval unless an allow rule covers them; read-only commands (ls, cat, echo, pwd, head, tail, grep, find, wc, which, diff, stat, du, cd, file, sort, ps on Linux and read-only git) run without asking.",
  acceptEdits:
    'File edits and the filesystem commands mkdir, touch, rm, rmdir, mv, cp and sed inside the workspace are accepted without asking, and read-only commands run without asking; other actions still need approval unless an allow rule covers them.',
  plan: "Do not edit files; research and propose a plan for the user to approve. Read-only commands (ls, cat, echo, pwd, head, tail, grep, find, wc, which, diff, stat, du, cd, file, sort, ps on Linux and read-only git) run without asking; any other command needs the user's approval unless an allow rule covers it.",
  auto: "Tool calls that would need approval are first reviewed by an automatic safety classifier; calls it does not clearly approve still need the user's approval. Stay within what the user asked.",
  bypassPermissions: 'Tool calls run without asking the user; be careful with destructive actions.',
};

const modeChangedText = (from: PermissionMode, to: PermissionMode): string =>
  `[The permission mode changed from ${from} to ${to}. ${MODE_RULE[to]} The set of available tools may differ from earlier in this conversation.]`;

const notExecutedText = (outcome: InheritanceOutcome): string => {
  if (outcome.status === 'CANCELLED') return CLOSURE_TEXT.cancelled;
  if (outcome.status === 'FAILED') return CLOSURE_TEXT.failed;
  switch (outcome.stopReason) {
    case 'approval_timeout':
      return CLOSURE_TEXT.approvalTimeout;
    case 'loop':
      return CLOSURE_TEXT.loop;
    case 'timeout':
      return CLOSURE_TEXT.timeout;
    default:
      return CLOSURE_TEXT.other;
  }
};

const startedPhrase = (outcome: InheritanceOutcome): string => {
  if (outcome.status === 'CANCELLED') return 'was interrupted by the user';
  if (outcome.status === 'FAILED') return 'ended with an error';
  return outcome.stopReason === 'timeout' ? 'ran out of time' : 'was stopped';
};

const startedText = (outcome: InheritanceOutcome): string =>
  `This tool call had started when the previous request ${startedPhrase(outcome)}. Its result was not recorded and its effect is unknown; inspect the current state before retrying it.`;

export const retractsTask = (state: RunState, outcome: InheritanceOutcome): boolean => state.pins === undefined && outcome.status === 'CANCELLED';

const userMarker = (text: string): InputItem => ({ type: 'message', role: 'user', content: text });

const inconsistent = (previous: RunState, detail: string): InheritanceError =>
  new InheritanceError('previous_run_inconsistent', `run ${previous.runId}: ${detail}`);

const digestOf = (payload: Pick<InheritedPayload, 'history' | 'nextItemSeq' | 'summary' | 'evicted' | 'mode' | 'activatedSkills' | 'workingFacts'>): string =>
  sha256Hex(
    canonicalJson({
      history: payload.history,
      nextItemSeq: payload.nextItemSeq,
      summary: payload.summary ?? null,
      evicted: payload.evicted,
      mode: payload.mode ?? null,
      ...(payload.activatedSkills === undefined ? {} : { activatedSkills: payload.activatedSkills }),
      ...(payload.workingFacts === undefined ? {} : { workingFacts: payload.workingFacts }),
    }),
  );

const partialText = (previous: RunState): string =>
  (previous.streaming?.items ?? [])
    .map((item) => item.text)
    .filter((text) => text !== '')
    .join('\n\n');

const isUserMessage = (entry: HistoryEntry | undefined): boolean =>
  entry !== undefined && entry.item.type === 'message' && entry.item.role === 'user';

const assertPaired = (previous: RunState, history: readonly HistoryEntry[]): void => {
  const dangling = findDanglingOutput(history);
  if (dangling !== undefined) throw inconsistent(previous, `output of call ${dangling.callId} at seq ${dangling.seq} has no call`);
};

export const projectInheritance = (previous: RunState, outcome: InheritanceOutcome, kind: InheritanceKind): InheritedPayload => {
  const retracted = retractsTask(previous, outcome);
  const dropped = outcome.status === 'FAILED' && outcome.errorCode === 'pinned_overflow' && previous.step === 0;
  if (dropped && outcome.carriedSkills === undefined) throw inconsistent(previous, 'the skills carried into a step-0 pinned_overflow run are not known');
  const activatedSkills = dropped ? previous.activatedSkills.filter((skill) => outcome.carriedSkills?.includes(skill.name) === true) : previous.activatedSkills;
  const history: HistoryEntry[] = previous.history.filter((entry) => !retracted || entry.seq !== previous.taskSeq).map((entry) => ({ ...entry }));
  const closures: InheritedPayload['closures'] = [];
  const markers: InheritedPayload['markers'] = [];
  let nextItemSeq = previous.nextItemSeq;
  let partial: InheritedPayload['partial'];

  const addMarker = (markerKind: MarkerKind, text: string): void => {
    const seq = nextItemSeq;
    nextItemSeq += 1;
    history.push({ seq, item: userMarker(text) });
    markers.push({ seq, kind: markerKind });
  };

  if (dropped) {
    const index = history.findIndex((entry) => entry.seq === previous.taskSeq);
    if (index < 0) throw inconsistent(previous, `the task at seq ${previous.taskSeq} is missing from a step-0 history`);
    history[index] = { seq: previous.taskSeq, item: userMarker(MARKER_TEXT.dropped) };
    markers.push({ seq: previous.taskSeq, kind: 'dropped' });
  }

  assertPaired(previous, history);
  for (const { callId } of findUnpairedCalls(history)) {
    const started = previous.pendingCalls[callId]?.status === 'started';
    const seq = nextItemSeq;
    nextItemSeq += 1;
    history.push({
      seq,
      item: { type: 'function_call_output', call_id: callId, output: started ? startedText(outcome) : notExecutedText(outcome) },
      callId,
    });
    closures.push({ callId, seq, effect: started ? 'unknown' : 'not_executed', announced: previous.pendingCalls[callId] !== undefined });
  }
  if (findUnpairedCalls(history).length > 0) throw inconsistent(previous, 'a call is still without an output after closing');

  const text = partialText(previous);
  if (text !== '') {
    partial = { seq: nextItemSeq };
    history.push({
      seq: nextItemSeq,
      item: { type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text, annotations: [] }] },
    });
    nextItemSeq += 1;
  }

  const queueTimeout = previous.pins === undefined && outcome.status === 'STOPPED' && outcome.stopReason === 'timeout';
  if (!dropped && !retracted && (partial !== undefined || queueTimeout || isUserMessage(history.at(-1)))) {
    if (queueTimeout) addMarker('unprocessed', MARKER_TEXT.unprocessed);
    else addMarker('interrupted', outcome.status === 'CANCELLED' ? MARKER_TEXT.userInterrupted : MARKER_TEXT.ended);
  }

  const mode = kind.kind === 'final' ? kind.currentMode : previous.mode;
  if (kind.kind === 'final' && previous.mode !== undefined && previous.mode !== kind.currentMode) {
    addMarker('mode_changed', modeChangedText(previous.mode, kind.currentMode));
  }

  const unsigned: Omit<InheritedPayload, 'digest'> = {
    type: 'context.inherited',
    fromRunId: previous.runId,
    fromLastSeq: previous.lastSeq,
    history,
    nextItemSeq,
    ...(previous.summary === undefined ? {} : { summary: previous.summary }),
    workingFacts: inheritedWorkingFacts(previous.workingFacts, !retracted),
    evicted: [...previous.evicted],
    closures,
    ...(partial === undefined ? {} : { partial }),
    markers,
    ...(previous.mode === undefined ? {} : { fromMode: previous.mode }),
    ...(mode === undefined ? {} : { mode }),
    ...(activatedSkills.length === 0 ? {} : { activatedSkills: activatedSkills.map((skill) => ({ ...skill })) }),
  };
  return { ...unsigned, digest: digestOf(unsigned) };
};

export const applyInheritance = (state: RunState, payload: InheritedPayload): RunState => {
  const task = state.history[0];
  if (
    state.inherited !== undefined ||
    state.history.length !== 1 ||
    task === undefined ||
    task.seq !== 1 ||
    state.taskSeq !== 1 ||
    state.step !== 0
  ) {
    throw new Error(`run ${state.runId}: context.inherited must follow the task of a run that has not started and has not inherited`);
  }
  if (digestOf(payload) !== payload.digest) {
    throw new Error(`run ${state.runId}: context.inherited digest does not match its content`);
  }
  const history = [...payload.history, { ...task, seq: payload.nextItemSeq }];
  if (!hasConsistentSeqs(history, payload.nextItemSeq + 1, payload.summary)) {
    throw new Error(`run ${state.runId}: context.inherited carries item seqs that are not strictly increasing below nextItemSeq`);
  }
  const { summary: _summary, mode: _mode, ...rest } = state;
  const carried = payload.activatedSkills ?? [];
  return {
    ...rest,
    activatedSkills: [...carried, ...state.activatedSkills.filter((skill) => !carried.some((entry) => entry.name === skill.name))],
    history,
    workingFacts: {
      ...(payload.workingFacts ?? emptyWorkingFacts()),
      ...(state.workingFacts.taskText === undefined ? {} : { taskText: state.workingFacts.taskText }),
      itemEvents: state.workingFacts.itemEvents.map((entry) => ({ itemSeq: payload.nextItemSeq, eventSeq: entry.eventSeq })),
    },
    nextItemSeq: payload.nextItemSeq + 1,
    taskSeq: payload.nextItemSeq,
    evicted: [...payload.evicted].sort(),
    inherited: { fromRunId: payload.fromRunId, fromLastSeq: payload.fromLastSeq, digest: payload.digest },
    ...(payload.summary === undefined ? {} : { summary: payload.summary }),
    ...(payload.mode === undefined ? {} : { mode: payload.mode }),
  };
};
