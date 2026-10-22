import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { STOP_REASONS } from '@momonga/protocol';
import type { RunEvent, RunState, StopReason } from '@momonga/protocol';

type PendingCall = RunState['pendingCalls'][string];

export const initialRunState = (ids: { runId: string; sessionId: string }): RunState => ({
  runId: ids.runId,
  sessionId: ids.sessionId,
  status: 'QUEUED',
  step: 0,
  attempt: 0,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  items: [],
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

const finishCall = (state: RunState, callId: string, eventType: string, status: PendingCall['status'], output: string): RunState => {
  const call = requireCall(state, callId, eventType);
  return {
    ...state,
    pendingCalls: { ...state.pendingCalls, [callId]: { ...call, status } },
    items: [...state.items, functionCallOutput(call.providerCallId, output)],
  };
};

const withoutInFlight = (state: RunState): RunState => {
  const { inFlightModelRequest: _removed, ...rest } = state;
  return rest;
};

const functionCallOutput = (providerCallId: string, output: string): unknown => ({
  type: 'function_call_output',
  call_id: providerCallId,
  output,
});

const applyEvent = (state: RunState, event: RunEvent): RunState => {
  switch (event.type) {
    case 'user.message':
      return {
        ...state,
        items: [...state.items, { type: 'message', role: 'user', content: [{ type: 'input_text', text: event.text }] }],
      };
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
        ...base,
        items: [...state.items, ...event.response.output],
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
      return withCall(state, event.callId, event.type, (call) => ({ ...call, status: 'awaiting_approval', approvalId: event.approvalId }));
    case 'tool.permission.resolved': {
      const entry = Object.entries(state.pendingCalls).find(([, call]) => call.approvalId === event.approvalId);
      if (entry === undefined) throw new Error(`run ${state.runId}: ${event.type} refers to unknown approval ${event.approvalId}`);
      return withCall(state, entry[0], event.type, (call) => ({ ...call, status: 'requested' }));
    }
    case 'tool.started':
      return withCall(state, event.callId, event.type, (call) => ({ ...call, status: 'started', idemKey: event.idemKey }));
    case 'tool.completed':
      return finishCall(state, event.callId, event.type, 'completed', event.output);
    case 'tool.reconciled':
      return finishCall(state, event.callId, event.type, 'reconciled', event.output);
    case 'context.compacted':
      return {
        ...state,
        items: [{ type: 'compaction_summary', summary: event.summary }, ...state.items.slice(event.replacedThroughItem + 1)],
      };
    case 'notice':
      return { ...state, notes: [...state.notes, { level: event.level, message: event.message }] };
    case 'agent.message.delta':
    case 'agent.thought.delta':
    case 'tool.updated':
    case 'plan.updated':
    case 'mode.changed':
    case 'usage.updated':
    case 'context.truncated':
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
