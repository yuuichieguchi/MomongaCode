import { escapeTerminalLine } from '@momonga/protocol';
import type { PermissionDenial, PermissionMode, PermissionOption, PublicRunEvent, RunStatus, ToolKind } from '@momonga/protocol';
import { startFlow } from '../elicit/flow.ts';
import { mcpAuthorizationNotice } from '../mcp/messages.ts';
import { selectableModes } from '../modes.ts';
import type { ModeAvailability } from '../modes.ts';
import { classificationLevel, describeClassification, describeHook, hookLevel } from '../policy-messages.ts';
import type { ElicitationFlow } from '../elicit/flow.ts';
import { asChildEvent } from '../run/child-events.ts';
import { isTerminalStatus } from '../run/follow.ts';

export type ToolStatus = 'requested' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'unknown';

export type PlanEntry = { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' };

export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; itemId: string; text: string; open: boolean }
  | { kind: 'tool'; callId: string; name: string; title: string; toolKind: ToolKind; rawInput: unknown; status: ToolStatus; output?: string; denial?: PermissionDenial }
  | { kind: 'plan'; entries: readonly PlanEntry[] }
  | { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'info'; text: string };

export type PendingApproval = { approvalId: string; callId: string; options: readonly PermissionOption[]; reason: string; suggestedRule?: string };

export type PendingElicitation = { inputId: string; callId: string; server: string; flow: ElicitationFlow; submitted: boolean };

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type Transcript = {
  entries: readonly Entry[];
  runId: string | undefined;
  runStatus: RunStatus | undefined;
  waiting: string | undefined;
  approval: PendingApproval | undefined;
  queuedApprovals: readonly PendingApproval[];
  elicitation: PendingElicitation | undefined;
  queuedElicitations: readonly PendingElicitation[];
  usage: Usage;
  contextTokens: number | undefined;
};

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export const initialTranscript: Transcript = {
  entries: [],
  runId: undefined,
  runStatus: undefined,
  waiting: undefined,
  approval: undefined,
  queuedApprovals: [],
  elicitation: undefined,
  queuedElicitations: [],
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

export const withElicitationFlow = (transcript: Transcript, flow: ElicitationFlow, submitted = false): Transcript =>
  transcript.elicitation === undefined ? transcript : { ...transcript, elicitation: { ...transcript.elicitation, flow, submitted } };

export const appendEntry = (transcript: Transcript, entry: Entry): Transcript => ({ ...transcript, entries: [...closeAssistant(transcript.entries), entry] });

type Pending = { readonly callId: string };

type Prompts<T extends Pending> = { head: T | undefined; queued: readonly T[] };

const enqueue = <T extends Pending>(prompts: Prompts<T>, item: T, same: (other: T) => boolean): Prompts<T> => {
  if (prompts.head !== undefined && same(prompts.head)) return prompts;
  if (prompts.queued.some(same)) return prompts;
  return prompts.head === undefined ? { head: item, queued: prompts.queued } : { head: prompts.head, queued: [...prompts.queued, item] };
};

const dequeue = <T extends Pending>(prompts: Prompts<T>, same: (other: T) => boolean): { prompts: Prompts<T>; removed: T } | undefined => {
  if (prompts.head !== undefined && same(prompts.head)) return { prompts: { head: prompts.queued[0], queued: prompts.queued.slice(1) }, removed: prompts.head };
  const removed = prompts.queued.find(same);
  if (removed === undefined) return undefined;
  return { prompts: { head: prompts.head, queued: prompts.queued.filter((other) => !same(other)) }, removed };
};

const releaseTool = (entries: readonly Entry[], callId: string): Entry[] =>
  updateTool(entries, callId, (tool) => (tool.status === 'awaiting_approval' ? { ...tool, status: 'requested' } : tool));

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
    case 'tool.permission.requested': {
      const pending: PendingApproval = {
        approvalId: event.approvalId,
        callId: event.callId,
        options: event.options,
        reason: event.reason,
        ...(event.suggestedRule === undefined ? {} : { suggestedRule: event.suggestedRule }),
      };
      const prompts = enqueue({ head: transcript.approval, queued: transcript.queuedApprovals }, pending, (other) => other.approvalId === event.approvalId);
      return {
        ...transcript,
        entries: updateTool(transcript.entries, event.callId, (tool) => ({ ...tool, status: 'awaiting_approval' })),
        approval: prompts.head,
        queuedApprovals: prompts.queued,
      };
    }
    case 'tool.permission.resolved':
    case 'tool.permission.cancelled': {
      const settled = dequeue({ head: transcript.approval, queued: transcript.queuedApprovals }, (other) => other.approvalId === event.approvalId);
      if (settled === undefined) return transcript;
      return {
        ...transcript,
        approval: settled.prompts.head,
        queuedApprovals: settled.prompts.queued,
        entries: releaseTool(transcript.entries, settled.removed.callId),
      };
    }
    case 'tool.elicitation.requested': {
      const pending: PendingElicitation = { inputId: event.inputId, callId: event.callId, server: event.server, flow: startFlow(event.requests, event.server), submitted: false };
      const prompts = enqueue({ head: transcript.elicitation, queued: transcript.queuedElicitations }, pending, (other) => other.inputId === event.inputId);
      return {
        ...transcript,
        entries: updateTool(transcript.entries, event.callId, (tool) => ({ ...tool, status: 'awaiting_approval' })),
        elicitation: prompts.head,
        queuedElicitations: prompts.queued,
      };
    }
    case 'tool.elicitation.resolved':
    case 'tool.elicitation.cancelled': {
      const settled = dequeue({ head: transcript.elicitation, queued: transcript.queuedElicitations }, (other) => other.inputId === event.inputId);
      if (settled === undefined) return transcript;
      return {
        ...transcript,
        elicitation: settled.prompts.head,
        queuedElicitations: settled.prompts.queued,
        entries: releaseTool(transcript.entries, settled.removed.callId),
      };
    }
    case 'mcp.authorization.required':
      return appendEntry(transcript, { kind: 'notice', level: 'warning', text: escapeTerminalLine(mcpAuthorizationNotice(event.server)) });
    case 'tool.started':
      return { ...transcript, entries: updateTool(transcript.entries, event.callId, (tool) => ({ ...tool, status: 'running' })) };
    case 'tool.completed':
      return {
        ...transcript,
        entries: updateTool(transcript.entries, event.callId, (tool) => ({
          ...tool,
          status: event.status,
          output: event.output,
          ...(event.denial === undefined ? {} : { denial: event.denial }),
        })),
      };
    case 'hook.completed':
      return appendEntry(transcript, { kind: 'notice', level: hookLevel(event), text: describeHook(event).map(escapeTerminalLine).join('\n') });
    case 'tool.permission.classified': {
      const title = transcript.entries.find((entry) => entry.kind === 'tool' && entry.callId === event.callId);
      return appendEntry(transcript, {
        kind: 'notice',
        level: classificationLevel(event),
        text: escapeTerminalLine(describeClassification(event, title?.kind === 'tool' ? title.title : event.callId)),
      });
    }
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
    case 'tool.loaded':
      return appendEntry(transcript, { kind: 'info', text: `tools loaded: ${event.names.join(', ')}` });
    case 'tool.waiting':
      return { ...transcript, waiting: event.awaits.kind === 'run' ? `subagent ${event.awaits.agent}` : `job ${event.awaits.jobId}` };
    case 'run.status': {
      const base = { ...transcript, runStatus: event.to, waiting: event.to === 'WAITING_TOOL' ? transcript.waiting : undefined };
      if (!isTerminalStatus(event.to)) return base;
      return {
        ...base,
        approval: undefined,
        queuedApprovals: [],
        elicitation: undefined,
        queuedElicitations: [],
        entries: closeAssistant(base.entries).map((entry) =>
          entry.kind === 'plan' ? { kind: 'info', text: entry.entries.map((item) => `${item.status === 'completed' ? '[x]' : '[ ]'} ${item.content}`).join('\n') } : entry,
        ),
      };
    }
    default:
      return transcript;
  }
};

export const reduceChildEvent = (transcript: Transcript, event: PublicRunEvent, agent: string): Transcript => {
  const child = asChildEvent(event, agent);
  return child === undefined ? transcript : reduceEvent(transcript, child);
};

export type ModeCycleInput = ModeAvailability & { current: PermissionMode };

export const nextMode = ({ current, ...availability }: ModeCycleInput): PermissionMode => {
  const available = selectableModes(availability);
  const index = available.indexOf(current);
  const next = available[(index + 1) % available.length];
  if (next === undefined) throw new Error('no permission mode is available to cycle to');
  return next;
};
