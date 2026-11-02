import type { PermissionMode, PermissionOption, PublicRunEvent, RunStatus, ToolKind } from '@momonga/protocol';
import { isTerminalStatus } from '../run/follow.ts';

export type ToolStatus = 'requested' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'unknown';

export type PlanEntry = { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' };

export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; itemId: string; text: string; open: boolean }
  | { kind: 'tool'; callId: string; name: string; title: string; toolKind: ToolKind; rawInput: unknown; status: ToolStatus; output?: string }
  | { kind: 'plan'; entries: readonly PlanEntry[] }
  | { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'info'; text: string };

export type PendingApproval = { approvalId: string; callId: string; options: readonly PermissionOption[]; suggestedRule?: string };

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type Transcript = {
  entries: readonly Entry[];
  runId: string | undefined;
  runStatus: RunStatus | undefined;
  approval: PendingApproval | undefined;
  usage: Usage;
  contextTokens: number | undefined;
};

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export const initialTranscript: Transcript = {
  entries: [],
  runId: undefined,
  runStatus: undefined,
  approval: undefined,
  usage: EMPTY_USAGE,
  contextTokens: undefined,
};

export const isSettled = (entry: Entry): boolean => {
  switch (entry.kind) {
    case 'assistant':
      return !entry.open;
    case 'tool':
      return entry.status === 'completed' || entry.status === 'failed' || entry.status === 'unknown';
    case 'plan':
      return false;
    default:
      return true;
  }
};

export const settledCount = (entries: readonly Entry[]): number => {
  const firstOpen = entries.findIndex((entry) => !isSettled(entry));
  return firstOpen < 0 ? entries.length : firstOpen;
};

const closeAssistant = (entries: readonly Entry[]): Entry[] =>
  entries.map((entry) => (entry.kind === 'assistant' && entry.open ? { ...entry, open: false } : entry));

const updateTool = (entries: readonly Entry[], callId: string, change: (tool: Extract<Entry, { kind: 'tool' }>) => Extract<Entry, { kind: 'tool' }>): Entry[] =>
  entries.map((entry) => (entry.kind === 'tool' && entry.callId === callId ? change(entry) : entry));

export const appendEntry = (transcript: Transcript, entry: Entry): Transcript => ({ ...transcript, entries: [...closeAssistant(transcript.entries), entry] });

export const reduceEvent = (transcript: Transcript, event: PublicRunEvent): Transcript => {
  switch (event.type) {
    case 'agent.message.delta': {
      const existing = transcript.entries.findIndex((entry) => entry.kind === 'assistant' && entry.itemId === event.itemId);
      if (existing >= 0) {
        return {
          ...transcript,
          entries: transcript.entries.map((entry, index) => (index === existing && entry.kind === 'assistant' ? { ...entry, text: entry.text + event.text } : entry)),
        };
      }
      return { ...transcript, entries: [...closeAssistant(transcript.entries), { kind: 'assistant', itemId: event.itemId, text: event.text, open: true }] };
    }
    case 'tool.call':
      return appendEntry(transcript, {
        kind: 'tool',
        callId: event.callId,
        name: event.name,
        title: event.title,
        toolKind: event.kind,
        rawInput: event.rawInput,
        status: 'requested',
      });
    case 'tool.permission.requested':
      return {
        ...transcript,
        entries: updateTool(transcript.entries, event.callId, (tool) => ({ ...tool, status: 'awaiting_approval' })),
        approval: {
          approvalId: event.approvalId,
          callId: event.callId,
          options: event.options,
          ...(event.suggestedRule === undefined ? {} : { suggestedRule: event.suggestedRule }),
        },
      };
    case 'tool.permission.resolved':
    case 'tool.permission.cancelled': {
      if (transcript.approval?.approvalId !== event.approvalId) return transcript;
      const { callId } = transcript.approval;
      return {
        ...transcript,
        approval: undefined,
        entries: updateTool(transcript.entries, callId, (tool) => (tool.status === 'awaiting_approval' ? { ...tool, status: 'requested' } : tool)),
      };
    }
    case 'tool.started':
      return { ...transcript, entries: updateTool(transcript.entries, event.callId, (tool) => ({ ...tool, status: 'running' })) };
    case 'tool.completed':
      return { ...transcript, entries: updateTool(transcript.entries, event.callId, (tool) => ({ ...tool, status: event.status, output: event.output })) };
    case 'tool.reconciled':
      return {
        ...transcript,
        entries: updateTool(transcript.entries, event.callId, (tool) => ({
          ...tool,
          status: event.outcome === 'unknown' ? 'unknown' : event.outcome === 'already_applied' ? 'completed' : 'failed',
          output: event.output,
        })),
      };
    case 'plan.updated': {
      const without = transcript.entries.filter((entry) => entry.kind !== 'plan');
      return { ...transcript, entries: [...closeAssistant(without), { kind: 'plan', entries: event.entries }] };
    }
    case 'usage.updated':
      return { ...transcript, usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens } };
    case 'model.responded':
      return { ...transcript, contextTokens: event.response.usage.total_tokens };
    case 'context.compacted':
      return appendEntry(transcript, { kind: 'notice', level: 'info', text: 'context compacted' });
    case 'notice':
      return appendEntry(transcript, { kind: 'notice', level: event.level, text: event.message });
    case 'run.status': {
      const base = { ...transcript, runStatus: event.to };
      if (!isTerminalStatus(event.to)) return base;
      return {
        ...base,
        approval: undefined,
        entries: closeAssistant(base.entries).map((entry) =>
          entry.kind === 'plan' ? { kind: 'info', text: entry.entries.map((item) => `${item.status === 'completed' ? '[x]' : '[ ]'} ${item.content}`).join('\n') } : entry,
        ),
      };
    }
    default:
      return transcript;
  }
};

export type ModeCycleInput = { current: PermissionMode; bypassAllowed: boolean };

export const MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export const nextMode = ({ current, bypassAllowed }: ModeCycleInput): PermissionMode => {
  const available = MODE_CYCLE.filter((mode) => mode !== 'bypassPermissions' || bypassAllowed);
  const index = available.indexOf(current);
  const next = available[(index + 1) % available.length];
  if (next === undefined) throw new Error('no permission mode is available to cycle to');
  return next;
};
