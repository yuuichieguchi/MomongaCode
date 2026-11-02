import { canonicalJson, parseJsonOrText, sha256Hex } from '@momonga/foundation';
import {
  LOOP_GROUPS_KEPT,
  STOP_REASONS,
  emptyWorkingFacts,
  findDanglingOutput,
  userMessageContent,
  withCommand,
  withItemEvents,
  withMessage,
  withReplacedThrough,
  withTaskText,
  withTouched,
  withWritten,
} from '@momonga/protocol';
import type { InputItem, RunEvent, RunEventPayload, RunState, StopReason, WorkingFacts } from '@momonga/protocol';
import { applyInheritance } from './inherit.ts';
import { isRecord } from './rows.ts';
import { touchedTargetOf } from './touched.ts';

type PendingCall = RunState['pendingCalls'][string];
type HistoryEntry = RunState['history'][number];

export const initialRunState = (ids: { runId: string; sessionId: string }): RunState => ({
  runId: ids.runId,
  sessionId: ids.sessionId,
  status: 'QUEUED',
  step: 0,
  attempt: 0,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  history: [],
  nextItemSeq: 1,
  workingFacts: emptyWorkingFacts(),
  evicted: [],
  pendingCalls: {},
  notes: [],
  toolCallCounts: {},
  steps: {},
  loadedInstructions: [],
  activatedSkills: [],
  loopGroups: [],
  taskSeq: 1,
  lastSeq: 0,
});

export const spendOf = (event: RunEventPayload): RunState['usage'] | undefined => {
  if (event.type === 'model.responded') {
    const { input_tokens, output_tokens, total_tokens } = event.response.usage;
    return { inputTokens: input_tokens, outputTokens: output_tokens, totalTokens: total_tokens };
  }
  if (event.type === 'usage.charged') return { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens };
  return undefined;
};

const requiredSpend = (event: RunEventPayload): RunState['usage'] => {
  const spend = spendOf(event);
  if (spend === undefined) throw new Error(`event ${event.type} carries no token spend`);
  return spend;
};

export const addUsage = (total: RunState['usage'], spend: RunState['usage']): RunState['usage'] => ({
  inputTokens: total.inputTokens + spend.inputTokens,
  outputTokens: total.outputTokens + spend.outputTokens,
  totalTokens: total.totalTokens + spend.totalTokens,
});

const toStopReason = (reason: string, state: RunState): StopReason => {
  const match = STOP_REASONS.find((candidate) => candidate === reason);
  if (match === undefined) {
    throw new Error(`run ${state.runId}: run.status to STOPPED carries unknown stop reason "${reason}"`);
  }
  return match;
};

const requireCall = (state: RunState, callId: string, eventType: string): PendingCall => {
  const call = state.pendingCalls[callId];
  if (call === undefined) throw new Error(`run ${state.runId}: ${eventType} refers to unknown tool call ${callId}`);
  return call;
};

const withCall = (state: RunState, callId: string, eventType: string, update: (call: PendingCall) => PendingCall): RunState => ({
  ...state,
  pendingCalls: { ...state.pendingCalls, [callId]: update(requireCall(state, callId, eventType)) },
});

const outputTextOf = (output: unknown): string => (typeof output === 'string' ? output : canonicalJson(output));

const digestOf = (value: unknown): string => sha256Hex(canonicalJson(value));

const closedGroup = (open: NonNullable<RunState['loopOpen']>): RunState['loopGroups'][number] => {
  const complete = Object.keys(open.outputs).length > 0 && open.callIds.every((callId) => open.outputs[callId] !== undefined);
  return {
    signature: digestOf(open.calls),
    ...(complete ? { outputSignature: digestOf(open.callIds.map((callId) => open.outputs[callId])) } : {}),
  };
};

const withLoopItem = (state: RunState, item: InputItem): RunState => {
  const open = state.loopOpen;
  if (item.type === 'function_call') {
    const call: [string, unknown] = [item.name, parseJsonOrText(item.arguments)];
    if (open !== undefined && Object.keys(open.outputs).length === 0) {
      return { ...state, loopOpen: { calls: [...open.calls, call], callIds: [...open.callIds, item.call_id], outputs: open.outputs } };
    }
    const loopGroups = open === undefined ? state.loopGroups : [...state.loopGroups, closedGroup(open)].slice(-LOOP_GROUPS_KEPT);
    return { ...state, loopGroups, loopOpen: { calls: [call], callIds: [item.call_id], outputs: {} } };
  }
  if (item.type === 'function_call_output' && open !== undefined) {
    return { ...state, loopOpen: { ...open, outputs: { ...open.outputs, [item.call_id]: digestOf(outputTextOf(item.output)) } } };
  }
  return state;
};

const withTouchedItems = (facts: WorkingFacts, items: readonly { item: InputItem }[]): WorkingFacts =>
  items.reduce((folded, { item }) => {
    const target = touchedTargetOf(item);
    return target === undefined ? folded : withTouched(folded, target);
  }, facts);

const appendItems = (state: RunState, items: readonly { item: InputItem; callId?: string }[], eventSeq: number, handle?: string): RunState =>
  items.reduce<RunState>((folded, { item }) => withLoopItem(folded, item), {
    ...state,
    workingFacts: withTouchedItems(
      withItemEvents(
        state.workingFacts,
        items.map((_item, offset) => state.nextItemSeq + offset),
        eventSeq,
      ),
      items,
    ),
    history: [
      ...state.history,
      ...items.map(
        ({ item, callId }, offset): HistoryEntry => ({
          seq: state.nextItemSeq + offset,
          item,
          ...(callId === undefined ? {} : { callId }),
          ...(handle === undefined ? {} : { handle }),
        }),
      ),
    ],
    nextItemSeq: state.nextItemSeq + items.length,
  });

const finishCall = (
  state: RunState,
  callId: string,
  eventType: string,
  status: PendingCall['status'],
  output: string,
  eventSeq: number,
  handle?: string,
): RunState => {
  const call = requireCall(state, callId, eventType);
  const settled = { ...state, pendingCalls: { ...state.pendingCalls, [callId]: { ...call, status } } };
  return appendItems(settled, [{ item: functionCallOutput(call.providerCallId, output), callId }], eventSeq, handle);
};

const FILE_WRITING_TOOLS: readonly string[] = ['Write', 'Edit'];

const stringArgument = (call: PendingCall, name: string): string | undefined => {
  const value = isRecord(call.arguments) ? call.arguments[name] : undefined;
  return typeof value === 'string' ? value : undefined;
};

const isBackgroundLaunch = (call: PendingCall): boolean => isRecord(call.arguments) && call.arguments['run_in_background'] === true;

const wasNotRun = (call: PendingCall, event: Extract<RunEvent, { type: 'tool.completed' }>): boolean =>
  event.denial !== undefined || call.resolution?.kind === 'reject_once' || call.resolution?.kind === 'reject_always';

const withToolFacts = (facts: WorkingFacts, call: PendingCall, event: Extract<RunEvent, { type: 'tool.completed' }>): WorkingFacts => {
  if (wasNotRun(call, event)) return facts;
  const { seq } = event;
  if (event.files !== undefined) {
    return event.files.reduce((folded, file) => (file.access === 'write' ? withWritten(folded, { path: file.path, sha256: file.sha256, seq }) : folded), facts);
  }
  if (event.status === 'completed' && FILE_WRITING_TOOLS.includes(call.name)) {
    const path = stringArgument(call, 'file_path');
    return path === undefined ? facts : withWritten(facts, { path, seq });
  }
  if (call.name === 'Bash' && !isBackgroundLaunch(call)) {
    const command = stringArgument(call, 'command');
    if (command === undefined) return facts;
    return withCommand(facts, {
      command,
      failed: event.status === 'failed',
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      seq,
    });
  }
  return facts;
};

const withReconciledFacts = (facts: WorkingFacts, call: PendingCall, event: Extract<RunEvent, { type: 'tool.reconciled' }>): WorkingFacts => {
  if (event.outcome === 'not_applied') return facts;
  const reconciled = event.outcome;
  const { seq } = event;
  if (FILE_WRITING_TOOLS.includes(call.name)) {
    const path = stringArgument(call, 'file_path');
    return path === undefined ? facts : withWritten(facts, { path, reconciled, seq });
  }
  const command = call.name === 'Bash' && !isBackgroundLaunch(call) ? stringArgument(call, 'command') : undefined;
  return command === undefined ? facts : withCommand(facts, { command, failed: false, reconciled, seq });
};

const reconcileCall = (state: RunState, event: Extract<RunEvent, { type: 'tool.reconciled' }>): RunState => {
  const call = requireCall(state, event.callId, event.type);
  const finished = finishCall(state, event.callId, event.type, 'reconciled', event.output, event.seq);
  return { ...finished, workingFacts: withReconciledFacts(finished.workingFacts, call, event) };
};

const completeCall = (state: RunState, event: Extract<RunEvent, { type: 'tool.completed' }>): RunState => {
  const call = requireCall(state, event.callId, event.type);
  const finished = finishCall(state, event.callId, event.type, 'completed', event.output, event.seq, event.handle);
  return { ...finished, workingFacts: withToolFacts(finished.workingFacts, call, event) };
};

const withoutInFlight = (state: RunState): RunState => {
  const { inFlightModelRequest: _removed, ...rest } = state;
  return rest;
};

const functionCallOutput = (providerCallId: string, output: string): InputItem => ({
  type: 'function_call_output',
  call_id: providerCallId,
  output,
});

const withoutStreaming = (state: RunState): RunState => {
  const { streaming: _removed, ...rest } = state;
  return rest;
};

const withDelta = (state: RunState, event: { step: number; attempt: number; itemId: string; text: string }, collectText: boolean): RunState => {
  const current = state.streaming;
  const record =
    current !== undefined && current.step === event.step && current.attempt === event.attempt
      ? current
      : { step: event.step, attempt: event.attempt, seen: false, items: [] };
  const items = !collectText
    ? record.items
    : record.items.some((item) => item.itemId === event.itemId)
      ? record.items.map((item) => (item.itemId === event.itemId ? { itemId: item.itemId, text: item.text + event.text } : item))
      : [...record.items, { itemId: event.itemId, text: event.text }];
  return { ...state, streaming: { step: record.step, attempt: record.attempt, seen: true, items } };
};

const rejectCompaction = (state: RunState, event: Extract<RunEvent, { type: 'context.compaction_rejected' }>): RunState => {
  if (state.summary === undefined) throw new Error(`run ${state.runId}: ${event.type} arrives without a summary`);
  if (state.summary.item.type !== 'compaction') throw new Error(`run ${state.runId}: ${event.type} arrives for a summary that is already a message`);
  const replaced = { ...state, summary: { ...state.summary, item: event.item } };
  if (event.attempt === undefined) return replaced;
  const inFlight = replaced.inFlightModelRequest;
  if (inFlight === undefined || inFlight.step !== event.step || inFlight.attempt !== event.attempt) return replaced;
  const { [event.step]: _abandoned, ...steps } = replaced.steps;
  return { ...withoutInFlight(replaced), steps };
};

const compact = (state: RunState, event: Extract<RunEvent, { type: 'context.compacted' }>): RunState => {
  const history = state.history.filter((entry) => entry.seq > event.replacedThroughSeq);
  const dangling = findDanglingOutput(history);
  if (dangling !== undefined) {
    throw new RangeError(
      `run ${state.runId}: summary boundary splits call ${dangling.callId}: output at seq ${dangling.seq} has no retained function_call`,
    );
  }
  return {
    ...state,
    history,
    workingFacts: withReplacedThrough(state.workingFacts, event.replacedThroughSeq),
    summary: { item: event.item, summary: event.summary, replacedThroughSeq: event.replacedThroughSeq },
  };
};

const isInheritedOutput = (state: RunState, callId: string): boolean =>
  state.history.some((entry) => entry.callId === callId && entry.item.type === 'function_call_output' && entry.seq < state.taskSeq);

const truncate = (state: RunState, event: Extract<RunEvent, { type: 'context.truncated' }>): RunState => {
  const call = state.pendingCalls[event.callId];
  if (call === undefined) {
    if (!isInheritedOutput(state, event.callId)) throw new Error(`run ${state.runId}: ${event.type} refers to unknown tool call ${event.callId}`);
  } else if (call.status !== 'completed' && call.status !== 'reconciled') {
    throw new Error(`run ${state.runId}: ${event.type} refers to tool call ${event.callId} that has not finished (${call.status})`);
  }
  const index = state.history.findIndex((entry) => entry.callId === event.callId && entry.item.type === 'function_call_output');
  if (index < 0) return state;
  const history = state.history.map((entry, position) => (position === index ? { ...entry, handle: event.handle } : entry));
  const evicted = event.kind === 'omitted' && !state.evicted.includes(event.callId) ? [...state.evicted, event.callId].sort() : state.evicted;
  return { ...state, history, evicted };
};

const isRefusalMessage = (item: unknown): boolean =>
  isRecord(item) &&
  item['type'] === 'message' &&
  Array.isArray(item['content']) &&
  item['content'].some((part: unknown) => isRecord(part) && part['type'] === 'refusal');

const callIdOf = (item: unknown): string[] =>
  isRecord(item) && item['type'] === 'function_call' && typeof item['call_id'] === 'string' ? [item['call_id']] : [];

const withStep = (steps: RunState['steps'], step: number, body: unknown): RunState['steps'] => {
  const toolChoice = typeof body === 'object' && body !== null && 'tool_choice' in body ? body.tool_choice : undefined;
  return typeof toolChoice === 'string' ? { ...steps, [step]: { toolChoice, summary: toolChoice === 'none' } } : steps;
};

const withInstruction = (current: RunState['loadedInstructions'], path: string, textSha256: string): RunState['loadedInstructions'] =>
  current.some((entry) => entry.path === path)
    ? current.map((entry) => (entry.path === path ? { path, textSha256 } : entry))
    : [...current, { path, textSha256 }];

const withSkill = (current: RunState['activatedSkills'], skill: RunState['activatedSkills'][number]): RunState['activatedSkills'] =>
  current.some((entry) => entry.name === skill.name) ? current : [...current, skill];

const applyEvent = (state: RunState, event: RunEvent): RunState => {
  switch (event.type) {
    case 'user.message': {
      const { lastResponse: _answered, ...rest } = state;
      const appended = appendItems(rest, [{ item: { type: 'message', role: 'user', content: userMessageContent(event.text, event.images) } }], event.seq);
      return {
        ...appended,
        workingFacts:
          state.lastSeq === 0
            ? withTaskText(appended.workingFacts, event.text)
            : withMessage(appended.workingFacts, { text: event.text, seq: event.seq }),
      };
    }
    case 'run.started':
      return {
        ...state,
        attempt: event.attempt,
        pins: state.pins ?? event.pins,
        ...(event.mode === undefined ? {} : { mode: event.mode }),
      };
    case 'run.status': {
      const next = { ...state, status: event.to };
      if (event.to === 'STOPPED' && event.reason !== undefined) return { ...next, stopReason: toStopReason(event.reason, state) };
      return next;
    }
    case 'model.requested':
      return {
        ...withoutStreaming(state),
        inFlightModelRequest: { step: event.step, attempt: event.attempt, digest: event.digest, body: event.body, requestedSeq: event.seq },
        steps: withStep(state.steps, event.step, event.body),
      };
    case 'model.responded': {
      const inFlight = state.inFlightModelRequest;
      const settled = inFlight !== undefined && inFlight.step === event.step && inFlight.attempt === event.attempt;
      const base = withoutStreaming(settled ? withoutInFlight(state) : state);
      return {
        ...appendItems(
          base,
          (event.response.output as InputItem[]).map((item) => ({ item })),
          event.seq,
        ),
        lastResponse: {
          step: event.step,
          incomplete: event.response.status === 'incomplete',
          refusal: event.response.output.some(isRefusalMessage),
          callIds: event.response.output.flatMap(callIdOf),
          ...(event.response.incompleteReason === undefined ? {} : { incompleteReason: event.response.incompleteReason }),
        },
        usage: addUsage(state.usage, requiredSpend(event)),
      };
    }
    case 'usage.charged':
      return { ...state, usage: addUsage(state.usage, requiredSpend(event)) };
    case 'tool.call': {
      if (state.pendingCalls[event.callId] !== undefined) {
        throw new Error(`run ${state.runId}: duplicate tool.call for call ${event.callId}`);
      }
      const key = sha256Hex(`${event.name}\n${canonicalJson(event.rawInput)}`);
      return {
        ...state,
        pendingCalls: {
          ...state.pendingCalls,
          [event.callId]: { name: event.name, providerCallId: event.providerCallId, arguments: event.rawInput, status: 'requested' },
        },
        toolCallCounts: { ...state.toolCallCounts, [key]: (state.toolCallCounts[key] ?? 0) + 1 },
      };
    }
    case 'tool.permission.classified': {
      const { subjectDigest } = event;
      if (typeof subjectDigest !== 'string') return state;
      return withCall(state, event.callId, event.type, (call) => ({ ...call, classification: { subjectDigest, outcome: event.outcome } }));
    }
    case 'tool.permission.requested':
      return withCall(state, event.callId, event.type, ({ resolution: _stale, ...call }) => ({ ...call, status: 'awaiting_approval', approvalId: event.approvalId, options: event.options, subjectDigest: event.subjectDigest, ...(event.suggestedRule === undefined ? {} : { suggestedRule: event.suggestedRule }) }));
    case 'tool.permission.resolved': {
      const entry = Object.entries(state.pendingCalls).find(([, call]) => call.approvalId === event.approvalId);
      if (entry === undefined) throw new Error(`run ${state.runId}: ${event.type} refers to unknown approval ${event.approvalId}`);
      return withCall(state, entry[0], event.type, (call) => {
        const option = call.options?.find((candidate) => candidate.optionId === event.optionId);
        if (option === undefined || call.subjectDigest === undefined) {
          throw new Error(`run ${state.runId}: ${event.type} for approval ${event.approvalId} names unknown option ${event.optionId}`);
        }
        const { options: _removed, suggestedRule, ...rest } = call;
        return {
          ...rest,
          status: 'requested',
          resolution: {
            optionId: option.optionId,
            kind: option.kind,
            subjectDigest: call.subjectDigest,
            ...(suggestedRule === undefined ? {} : { suggestedRule }),
          },
        };
      });
    }
    case 'tool.permission.cancelled': {
      const entry = Object.entries(state.pendingCalls).find(([, call]) => call.approvalId === event.approvalId);
      if (entry === undefined) throw new Error(`run ${state.runId}: ${event.type} refers to unknown approval ${event.approvalId}`);
      return withCall(state, entry[0], event.type, (call) => {
        const { approvalId: _approval, options: _options, subjectDigest: _digest, suggestedRule: _rule, ...rest } = call;
        return { ...rest, status: 'requested' };
      });
    }
    case 'tool.elicitation.requested':
      return withCall(state, event.callId, event.type, ({ inputResolution: _stale, ...call }) => ({
        ...call,
        status: 'awaiting_input',
        input: { inputId: event.inputId, server: event.server, requests: event.requests },
      }));
    case 'tool.elicitation.resolved': {
      const entry = Object.entries(state.pendingCalls).find(([, call]) => call.input?.inputId === event.inputId);
      if (entry === undefined) throw new Error(`run ${state.runId}: ${event.type} refers to unknown elicitation ${event.inputId}`);
      return withCall(state, entry[0], event.type, ({ input: _answered, ...call }) => ({
        ...call,
        status: 'started',
        inputResolution: { inputId: event.inputId, responses: event.responses },
      }));
    }
    case 'tool.elicitation.cancelled': {
      const entry = Object.entries(state.pendingCalls).find(([, call]) => call.input?.inputId === event.inputId);
      if (entry === undefined) throw new Error(`run ${state.runId}: ${event.type} refers to unknown elicitation ${event.inputId}`);
      return withCall(state, entry[0], event.type, ({ input: _withdrawn, ...call }) => ({ ...call, status: 'started' }));
    }
    case 'mcp.authorization.required':
      return state;
    case 'tool.started':
      return withCall(state, event.callId, event.type, (call) => ({ ...call, status: 'started', idemKey: event.idemKey }));
    case 'tool.completed':
      return completeCall(state, event);
    case 'tool.reconciled':
      return reconcileCall(state, event);
    case 'context.compacted':
      return compact(state, event);
    case 'context.compaction_rejected':
      return rejectCompaction(state, event);
    case 'context.inherited':
      return applyInheritance(state, event);
    case 'context.truncated':
      return truncate(state, event);
    case 'notice':
      return { ...state, notes: [...state.notes, { level: event.level, message: event.message }] };
    case 'agent.message.delta':
      return withDelta(state, event, true);
    case 'agent.thought.delta':
      return withDelta(state, event, false);
    case 'model.stream.restarted':
      return state.streaming?.step === event.step && state.streaming.attempt === event.attempt ? withoutStreaming(state) : state;
    case 'tool.waiting':
      return withCall(state, event.callId, event.type, (call) => ({ ...call, awaiting: event.awaits }));
    case 'plan.updated':
      return { ...state, workingFacts: { ...state.workingFacts, plan: { seq: event.seq, entries: event.entries } } };
    case 'job.finished':
    case 'hook.completed':
    case 'tool.updated':
    case 'usage.updated':
    case 'context.contribution':
      return state;
    case 'context.governing_loaded':
      return { ...state, governingLoaded: { active: event.active, conflicts: event.conflicts } };
    case 'context.memories_loaded':
      return { ...state, memoriesLoaded: event.memories };
    case 'instructions.loaded':
      return { ...state, loadedInstructions: withInstruction(state.loadedInstructions, event.path, sha256Hex(event.content)) };
    case 'skill.activated':
      return { ...state, activatedSkills: withSkill(state.activatedSkills, { name: event.name, content: event.content }) };
    case 'approval.rule.persisted': {
      const entry = Object.entries(state.pendingCalls).find(([, call]) => call.approvalId === event.approvalId);
      if (entry === undefined) throw new Error(`run ${state.runId}: ${event.type} refers to unknown approval ${event.approvalId}`);
      return withCall(state, entry[0], event.type, (call) => {
        if (call.resolution === undefined) throw new Error(`run ${state.runId}: ${event.type} for approval ${event.approvalId} precedes its resolution`);
        return { ...call, resolution: { ...call.resolution, rulePersisted: true } };
      });
    }
    default: {
      const unhandled: never = event;
      throw new Error(`run ${state.runId}: unhandled event ${JSON.stringify(unhandled)}`);
    }
  }
};

export const foldRunState = (state: RunState, event: RunEvent): RunState => {
  const next = applyEvent(state, event);
  return { ...next, step: Math.max(next.step, event.step), lastSeq: event.seq };
};
