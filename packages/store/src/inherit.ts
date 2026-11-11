import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { emptyWorkingFacts, findDanglingOutput, findUnpairedCalls, inheritedWorkingFacts, isInheritedReference } from '@momonga/protocol';
import { hasConsistentSeqs } from './seqs.ts';
import type { InheritedCopyPayload, InheritedReferencePayload, InheritedSynthesisEntry, InheritedViaLink, InputItem, PermissionMode, RunEventPayload, RunState, StopReason, TerminalStatus } from '@momonga/protocol';

export type InheritedPayload = InheritedCopyPayload;

export type ReferencePayload = InheritedReferencePayload;

export type UnsignedReference = Omit<InheritedReferencePayload, 'digest'>;

export const isReferenceInherited = isInheritedReference;

export type InheritanceOutcome = { status: TerminalStatus; stopReason?: StopReason; errorCode?: string; carriedSkills?: readonly string[] };

export type InheritanceKind = { kind: 'final'; currentMode: PermissionMode; unasked: UnaskedCommands } | { kind: 'intermediate' };

export const INHERITANCE_ERROR_CODES = ['previous_run_unreadable', 'previous_run_inconsistent'] as const;

export type InheritanceErrorCode = (typeof INHERITANCE_ERROR_CODES)[number];

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
  usageLimit: 'Not run: the previous request stopped because the usage allowance was reached before this tool call ran.',
  failed: 'Not run: the previous request ended with an error before this tool call ran.',
  other: 'Not run: the previous request was stopped before this tool call ran.',
} as const;

const MARKER_TEXT = {
  userInterrupted: '[The user interrupted the previous request before it was finished.]',
  ended: '[The previous request ended before it was finished.]',
  unprocessed: '[The previous request was never processed: it timed out while waiting in the queue.]',
  dropped: '[A previous message was too large to process and was dropped.]',
} as const;

export type UnaskedCommands = { readOnly: readonly string[]; edit: readonly string[] };

const readOnlySentence = (unasked: UnaskedCommands): string => `Read-only uses of these commands run without asking: ${unasked.readOnly.join(', ')}.`;

const MODE_RULE: Record<PermissionMode, (unasked: UnaskedCommands) => string> = {
  manual: (unasked) => `File changes and commands need the user's approval unless an allow rule covers them. ${readOnlySentence(unasked)}`,
  acceptEdits: (unasked) =>
    `File edits and these filesystem commands inside the workspace are accepted without asking: ${unasked.edit.join(', ')}. ${readOnlySentence(unasked)} Other actions still need approval unless an allow rule covers them.`,
  plan: (unasked) =>
    `Do not edit files; research and propose a plan for the user to approve. ${readOnlySentence(unasked)} Any other command needs the user's approval unless an allow rule covers it.`,
  auto: () => "Tool calls that would need approval are first reviewed by an automatic safety classifier; calls it does not clearly approve still need the user's approval. Stay within what the user asked.",
  bypassPermissions: () => 'Tool calls run without asking the user; be careful with destructive actions.',
};

const modeChangedText = (from: PermissionMode, to: PermissionMode, unasked: UnaskedCommands): string =>
  `[The permission mode changed from ${from} to ${to}. ${MODE_RULE[to](unasked)} The set of available tools may differ from earlier in this conversation.]`;

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
    case 'usage_limit':
      return CLOSURE_TEXT.usageLimit;
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

export const copyDigestOf = (payload: Pick<InheritedPayload, 'history' | 'nextItemSeq' | 'summary' | 'evicted' | 'mode' | 'activatedSkills' | 'workingFacts'>): string =>
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

type Projection = {
  history: HistoryEntry[];
  retracted: boolean;
  omitSeqs: number[];
  synthesised: InheritedSynthesisEntry[];
  closures: InheritedPayload['closures'];
  markers: InheritedPayload['markers'];
  partial: InheritedPayload['partial'];
  nextItemSeq: number;
  mode: PermissionMode | undefined;
  activatedSkills: InheritedPayload['activatedSkills'];
};

const lastResponseStart = (previous: RunState, history: readonly HistoryEntry[]): number => {
  const calls = previous.lastResponse?.callIds ?? [];
  const start = history.findIndex((entry) => entry.item.type === 'function_call' && calls.includes(entry.item.call_id));
  return start < 0 ? history.length : start;
};

const projectionOf = (previous: RunState, outcome: InheritanceOutcome, kind: InheritanceKind, pairing: 'whole' | 'last_response'): Projection => {
  const retracted = retractsTask(previous, outcome);
  const dropped = outcome.status === 'FAILED' && outcome.errorCode === 'pinned_overflow' && previous.step === 0;
  if (dropped && outcome.carriedSkills === undefined) throw inconsistent(previous, 'the skills carried into a step-0 pinned_overflow run are not known');
  const carriedSkills = dropped ? previous.activatedSkills.filter((skill) => outcome.carriedSkills?.includes(skill.name) === true) : previous.activatedSkills;
  const history: HistoryEntry[] = previous.history.filter((entry) => !retracted || entry.seq !== previous.taskSeq).map((entry) => ({ ...entry }));
  const synthesised: InheritedSynthesisEntry[] = [];
  const closures: InheritedPayload['closures'] = [];
  const markers: InheritedPayload['markers'] = [];
  let nextItemSeq = previous.nextItemSeq;
  let partial: InheritedPayload['partial'];

  const addMarker = (markerKind: MarkerKind, text: string): void => {
    const seq = nextItemSeq;
    nextItemSeq += 1;
    history.push({ seq, item: userMarker(text) });
    synthesised.push({ seq, item: userMarker(text) });
    markers.push({ seq, kind: markerKind });
  };

  if (dropped) {
    const index = history.findIndex((entry) => entry.seq === previous.taskSeq);
    if (index < 0) throw inconsistent(previous, `the task at seq ${previous.taskSeq} is missing from a step-0 history`);
    history[index] = { seq: previous.taskSeq, item: userMarker(MARKER_TEXT.dropped) };
    synthesised.push({ seq: previous.taskSeq, item: userMarker(MARKER_TEXT.dropped) });
    markers.push({ seq: previous.taskSeq, kind: 'dropped' });
  }

  const pairedFrom = pairing === 'whole' ? 0 : lastResponseStart(previous, history);
  assertPaired(previous, history.slice(pairedFrom));
  for (const { callId } of findUnpairedCalls(history.slice(pairedFrom))) {
    const started = previous.pendingCalls[callId]?.status === 'started';
    const seq = nextItemSeq;
    nextItemSeq += 1;
    const entry = {
      seq,
      item: { type: 'function_call_output' as const, call_id: callId, output: started ? startedText(outcome) : notExecutedText(outcome) },
      callId,
    };
    history.push(entry);
    synthesised.push({ ...entry, item: { ...entry.item } });
    closures.push({ callId, seq, effect: started ? 'unknown' : 'not_executed', announced: previous.pendingCalls[callId] !== undefined });
  }
  if (findUnpairedCalls(history.slice(pairedFrom)).length > 0) throw inconsistent(previous, 'a call is still without an output after closing');

  const text = partialText(previous);
  if (text !== '') {
    partial = { seq: nextItemSeq };
    const item: InputItem = { type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text, annotations: [] }] };
    history.push({ seq: nextItemSeq, item });
    synthesised.push({ seq: nextItemSeq, item });
    nextItemSeq += 1;
  }

  const queueTimeout = previous.pins === undefined && outcome.status === 'STOPPED' && outcome.stopReason === 'timeout';
  if (!dropped && !retracted && (partial !== undefined || queueTimeout || isUserMessage(history.at(-1)))) {
    if (queueTimeout) addMarker('unprocessed', MARKER_TEXT.unprocessed);
    else addMarker('interrupted', outcome.status === 'CANCELLED' ? MARKER_TEXT.userInterrupted : MARKER_TEXT.ended);
  }

  const mode = kind.kind === 'final' ? kind.currentMode : previous.mode;
  if (kind.kind === 'final' && previous.mode !== undefined && previous.mode !== kind.currentMode) {
    addMarker('mode_changed', modeChangedText(previous.mode, kind.currentMode, kind.unasked));
  }

  const omitSeqs = retracted || dropped ? [previous.taskSeq] : [];
  return {
    history,
    retracted,
    omitSeqs,
    synthesised,
    closures,
    markers,
    partial,
    nextItemSeq,
    mode,
    activatedSkills: carriedSkills.length === 0 ? undefined : carriedSkills.map(({ name, content }) => ({ name, content })),
  };
};

export const projectInheritance = (previous: RunState, outcome: InheritanceOutcome, kind: InheritanceKind): InheritedPayload => {
  const { history, retracted, closures, markers, partial, nextItemSeq, mode, activatedSkills } = projectionOf(previous, outcome, kind, 'whole');
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
    ...(activatedSkills === undefined ? {} : { activatedSkills }),
  };
  return { ...unsigned, digest: copyDigestOf(unsigned) };
};

export type ReferenceSource = {
  fromRunId: string;
  fromLastSeq: number;
  fromNextItemSeq: number;
  compaction?: { runId: string; eventSeq: number };
  via: InheritedViaLink[];
  itemCount: number;
};

export type ReferenceProjection = { unsigned: UnsignedReference; link: Omit<InheritedViaLink, 'runId' | 'lastSeq'> };

export const projectReference = (previous: RunState, outcome: InheritanceOutcome, kind: InheritanceKind, source: ReferenceSource): ReferenceProjection => {
  const { retracted, omitSeqs, synthesised, closures, markers, partial, nextItemSeq, mode, activatedSkills } = projectionOf(previous, outcome, kind, 'last_response');
  const unsigned: UnsignedReference = {
    type: 'context.inherited',
    form: 'reference',
    fromRunId: source.fromRunId,
    fromLastSeq: source.fromLastSeq,
    nextItemSeq,
    fromNextItemSeq: source.fromNextItemSeq,
    ...(source.compaction === undefined ? {} : { compaction: source.compaction }),
    omitSeqs,
    synthesised,
    via: source.via,
    itemCount: source.itemCount,
    workingFacts: inheritedWorkingFacts(previous.workingFacts, !retracted),
    closures,
    ...(partial === undefined ? {} : { partial }),
    markers,
    ...(previous.mode === undefined ? {} : { fromMode: previous.mode }),
    ...(mode === undefined ? {} : { mode }),
    ...(activatedSkills === undefined ? {} : { activatedSkills }),
  };
  return { unsigned, link: { nextItemSeq, omitSeqs, synthesised } };
};

const REFERENCE_FIELDS = [
  'type',
  'form',
  'fromRunId',
  'fromLastSeq',
  'nextItemSeq',
  'fromNextItemSeq',
  'compaction',
  'omitSeqs',
  'synthesised',
  'via',
  'itemCount',
  'workingFacts',
  'closures',
  'partial',
  'markers',
  'fromMode',
  'mode',
  'activatedSkills',
] as const satisfies readonly (keyof UnsignedReference)[];

export const referenceDigest = (unsigned: UnsignedReference): string =>
  sha256Hex(canonicalJson(Object.fromEntries(REFERENCE_FIELDS.flatMap((field) => (unsigned[field] === undefined ? [] : [[field, unsigned[field]]])))));

export const referencePayload = (reference: InheritedReferencePayload): RunEventPayload => reference;

export const signReference = (unsigned: UnsignedReference): InheritedReferencePayload => ({ ...unsigned, digest: referenceDigest(unsigned) });

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
  if (copyDigestOf(payload) !== payload.digest) {
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
    activatedSkills: [
      ...carried.map((skill) => ({ ...skill, seq: state.lastSeq + 1 })),
      ...state.activatedSkills.filter((skill) => !carried.some((entry) => entry.name === skill.name)),
    ],
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

type RebasedShape = Pick<InheritedReferencePayload, 'nextItemSeq' | 'workingFacts' | 'activatedSkills' | 'mode'>;

export const rebaseOntoReference = (state: RunState, shape: RebasedShape, inherited: NonNullable<RunState['inherited']>): RunState => {
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
  const { summary: _summary, mode: _mode, ...rest } = state;
  const carried = shape.activatedSkills ?? [];
  return {
    ...rest,
    activatedSkills: [
      ...carried.map((skill) => ({ ...skill, seq: state.lastSeq + 1 })),
      ...state.activatedSkills.filter((skill) => !carried.some((entry) => entry.name === skill.name)),
    ],
    history: [{ ...task, seq: shape.nextItemSeq }],
    workingFacts: {
      ...(shape.workingFacts ?? emptyWorkingFacts()),
      ...(state.workingFacts.taskText === undefined ? {} : { taskText: state.workingFacts.taskText }),
      itemEvents: state.workingFacts.itemEvents.map((entry) => ({ itemSeq: shape.nextItemSeq, eventSeq: entry.eventSeq })),
    },
    nextItemSeq: shape.nextItemSeq + 1,
    taskSeq: shape.nextItemSeq,
    evicted: [],
    inherited,
    ...(shape.mode === undefined ? {} : { mode: shape.mode }),
  };
};

export const inheritedScalarsOf = (payload: InheritedReferencePayload): NonNullable<RunState['inherited']> => ({
  fromRunId: payload.fromRunId,
  fromLastSeq: payload.fromLastSeq,
  digest: payload.digest,
  form: 'reference',
  fromNextItemSeq: payload.fromNextItemSeq,
  ...(payload.compaction === undefined ? {} : { compaction: payload.compaction }),
  itemCount: payload.itemCount,
});

export const applyReferenceInheritance = (state: RunState, payload: InheritedReferencePayload): RunState => {
  if (referenceDigest(payload) !== payload.digest) {
    throw new Error(`run ${state.runId}: context.inherited digest does not match its content`);
  }
  return rebaseOntoReference(state, payload, inheritedScalarsOf(payload));
};
