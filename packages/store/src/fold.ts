import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { STOP_REASONS, findDanglingOutput } from '@momonga/protocol';
import type { InputItem, RunEvent, RunState, StopReason } from '@momonga/protocol';

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
  evicted: [],
  pendingCalls: {},
  notes: [],
  toolCallCounts: {},
  lastSeq: 0,
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

const appendItems = (state: RunState, items: readonly { item: InputItem; callId?: string }[], handle?: string): RunState => ({
  ...state,
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
  handle?: string,
): RunState => {
  const call = requireCall(state, callId, eventType);
  const settled = { ...state, pendingCalls: { ...state.pendingCalls, [callId]: { ...call, status } } };
  return appendItems(settled, [{ item: functionCallOutput(call.providerCallId, output), callId }], handle);
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

const compact = (state: RunState, event: Extract<RunEvent, { type: 'context.compacted' }>): RunState => {
  const history = state.history.filter((entry) => entry.seq > event.replacedThroughSeq);
  const dangling = findDanglingOutput(history);
  if (dangling !== undefined) {
    throw new RangeError(
      `run ${state.runId}: summary boundary splits call ${dangling.callId}: output at seq ${dangling.seq} has no retained function_call`,
    );
  }
  return { ...state, history, summary: { item: event.item, summary: event.summary, replacedThroughSeq: event.replacedThroughSeq } };
};

const truncate = (state: RunState, event: Extract<RunEvent, { type: 'context.truncated' }>): RunState => {
  const call = state.pendingCalls[event.callId];
  if (call === undefined) throw new Error(`run ${state.runId}: ${event.type} refers to unknown tool call ${event.callId}`);
  if (call.status !== 'completed' && call.status !== 'reconciled') {
    throw new Error(`run ${state.runId}: ${event.type} refers to tool call ${event.callId} that has not finished (${call.status})`);
  }
  const index = state.history.findIndex((entry) => entry.callId === event.callId && entry.item.type === 'function_call_output');
  if (index < 0) return state;
  const history = state.history.map((entry, position) => (position === index ? { ...entry, handle: event.handle } : entry));
  const evicted = event.kind === 'omitted' && !state.evicted.includes(event.callId) ? [...state.evicted, event.callId].sort() : state.evicted;
  return { ...state, history, evicted };
};

const applyEvent = (state: RunState, event: RunEvent): RunState => {
  switch (event.type) {
    case 'user.message':
      return appendItems(state, [{ item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: event.text }] } }]);
    case 'run.started':
      return { ...state, attempt: event.attempt };
    case 'run.status': {
      const next = { ...state, status: event.to };
      if (event.to === 'STOPPED' && event.reason !== undefined) return { ...next, stopReason: toStopReason(event.reason, state) };
      return next;
    }
    case 'model.requested':
      return {
        ...state,
        inFlightModelRequest: { step: event.step, attempt: event.attempt, digest: event.digest, body: event.body },
      };
    case 'model.responded': {
      const inFlight = state.inFlightModelRequest;
      const settled = inFlight !== undefined && inFlight.step === event.step && inFlight.attempt === event.attempt;
      const base = settled ? withoutInFlight(state) : state;
      const { input_tokens, output_tokens, total_tokens } = event.response.usage;
      return {
        ...appendItems(
          base,
          (event.response.output as InputItem[]).map((item) => ({ item })),
        ),
        usage: {
          inputTokens: state.usage.inputTokens + input_tokens,
          outputTokens: state.usage.outputTokens + output_tokens,
          totalTokens: state.usage.totalTokens + total_tokens,
        },
      };
    }
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
    case 'tool.permission.requested':
      return withCall(state, event.callId, event.type, (call) => ({ ...call, status: 'awaiting_approval', approvalId: event.approvalId, options: event.options, subjectDigest: event.subjectDigest }));
    case 'tool.permission.resolved': {
      const entry = Object.entries(state.pendingCalls).find(([, call]) => call.approvalId === event.approvalId);
      if (entry === undefined) throw new Error(`run ${state.runId}: ${event.type} refers to unknown approval ${event.approvalId}`);
      return withCall(state, entry[0], event.type, (call) => {
        const option = call.options?.find((candidate) => candidate.optionId === event.optionId);
        if (option === undefined || call.subjectDigest === undefined) {
          throw new Error(`run ${state.runId}: ${event.type} for approval ${event.approvalId} names unknown option ${event.optionId}`);
        }
        const { options: _removed, ...rest } = call;
        return { ...rest, status: 'requested', resolution: { optionId: option.optionId, kind: option.kind, subjectDigest: call.subjectDigest } };
      });
    }
    case 'tool.started':
      return withCall(state, event.callId, event.type, (call) => ({ ...call, status: 'started', idemKey: event.idemKey }));
    case 'tool.completed':
      return finishCall(state, event.callId, event.type, 'completed', event.output, event.handle);
    case 'tool.reconciled':
      return finishCall(state, event.callId, event.type, 'reconciled', event.output);
    case 'context.compacted':
      return compact(state, event);
    case 'context.truncated':
      return truncate(state, event);
    case 'notice':
      return { ...state, notes: [...state.notes, { level: event.level, message: event.message }] };
    case 'agent.message.delta':
    case 'agent.thought.delta':
    case 'tool.updated':
    case 'plan.updated':
    case 'mode.changed':
    case 'usage.updated':
    case 'instructions.loaded':
      return state;
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
