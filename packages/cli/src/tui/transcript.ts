import { escapeTerminalLine } from '@momonga/protocol';
import type { PermissionDenial, PermissionMode, PermissionOption, PublicRunEvent, ToolKind } from '@momonga/protocol';
import { startFlow } from '../elicit/flow.ts';
import { mcpAuthorizationNotice } from '../mcp/messages.ts';
import { selectableModes } from '../modes.ts';
import type { ModeAvailability } from '../modes.ts';
import { classificationLevel, describeClassification, describeHook, hookLevel } from '../policy-messages.ts';
import type { ElicitationFlow } from '../elicit/flow.ts';
import { describeRetryWait } from '../retry-wait.ts';
import { asChildEvent } from '../run/child-events.ts';
import { isTerminalStatus } from '../run/follow.ts';
import { EMPTY_USAGE } from './screen/store.ts';
import type { TranscriptState, TranscriptStore } from './screen/store.ts';
import type { StartupBanner } from './startup.tsx';

export type ToolStatus = 'requested' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'unknown';

export type PlanEntry = { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' };

export type Entry =
  | { kind: 'banner'; banner: StartupBanner }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; itemId: string; text: string; open: boolean }
  | { kind: 'tool'; callId: string; name: string; title: string; toolKind: ToolKind; rawInput: unknown; status: ToolStatus; output?: string; denial?: PermissionDenial }
  | { kind: 'plan'; entries: readonly PlanEntry[] }
  | { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'retired' };

export type ToolEntry = Extract<Entry, { kind: 'tool' }>;

export type PendingApproval = { approvalId: string; callId: string; options: readonly PermissionOption[]; reason: string; suggestedRule?: string };

export type PendingElicitation = { inputId: string; callId: string; server: string; flow: ElicitationFlow; submitted: boolean };

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type Subagent = { runId: string; agent: string; title: string | undefined; startedAt: number; awaitingApproval: boolean };

export const BANNER_KEY = 'banner';
const PLAN_KEY = 'plan';
const itemKey = (itemId: string): string => `item:${itemId}`;
const callKey = (callId: string): string => `call:${callId}`;
const approvalKey = (approvalId: string): string => `approval:${approvalId}`;
const inputKey = (inputId: string): string => `input:${inputId}`;

export const sessionTokens = (state: Pick<TranscriptState, 'endedRunsTokens' | 'usage'>): number => state.endedRunsTokens + state.usage.totalTokens;

export const toolOf = (store: TranscriptStore, callId: string): ToolEntry | undefined => {
  const found = store.byKey(callKey(callId))?.entry;
  return found?.kind === 'tool' ? found : undefined;
};

const closeAssistant = (store: TranscriptStore): void => {
  const open = store.open();
  if (open === undefined) return;
  store.change(open, (entry) => (entry.kind === 'assistant' && entry.open ? { ...entry, open: false } : entry));
  store.setOpen(undefined);
};

const updateTool = (store: TranscriptStore, callId: string, change: (tool: ToolEntry) => ToolEntry): void => {
  store.change(callKey(callId), (entry) => (entry.kind === 'tool' ? change(entry) : entry));
};

export const withElicitationFlow = (store: TranscriptStore, flow: ElicitationFlow, submitted = false): void => {
  const { elicitation } = store.state();
  if (elicitation !== undefined) store.update({ elicitation: { ...elicitation, flow, submitted } });
};

export const appendEntry = (store: TranscriptStore, entry: Entry, key?: string): void => {
  closeAssistant(store);
  store.append(entry, key);
};

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

const releaseTool = (store: TranscriptStore, callId: string): void => {
  updateTool(store, callId, (tool) => (tool.status === 'awaiting_approval' ? { ...tool, status: 'requested' } : tool));
};

const retirePlan = (store: TranscriptStore, replacement: Entry): void => {
  store.change(PLAN_KEY, () => replacement);
  store.forget(PLAN_KEY);
};

const planText = (entries: readonly PlanEntry[]): string => entries.map((item) => `${item.status === 'completed' ? '[x]' : '[ ]'} ${item.content}`).join('\n');

export const foldEvent = (store: TranscriptStore, event: PublicRunEvent): void => {
  const state = store.state();
  switch (event.type) {
    case 'agent.message.delta': {
      const key = itemKey(event.itemId);
      if (store.byKey(key) !== undefined) {
        store.change(key, (entry) => (entry.kind === 'assistant' ? { ...entry, text: entry.text + event.text } : entry));
        return;
      }
      appendEntry(store, { kind: 'assistant', itemId: event.itemId, text: event.text, open: true }, key);
      store.setOpen(key);
      return;
    }
    case 'tool.call':
      appendEntry(
        store,
        { kind: 'tool', callId: event.callId, name: event.name, title: event.title, toolKind: event.kind, rawInput: event.rawInput, status: 'requested' },
        callKey(event.callId),
      );
      return;
    case 'tool.permission.requested': {
      const pending: PendingApproval = {
        approvalId: event.approvalId,
        callId: event.callId,
        options: event.options,
        reason: event.reason,
        ...(event.suggestedRule === undefined ? {} : { suggestedRule: event.suggestedRule }),
      };
      const prompts = enqueue({ head: state.approval, queued: state.queuedApprovals }, pending, (other) => other.approvalId === event.approvalId);
      store.name(approvalKey(event.approvalId), callKey(event.callId));
      updateTool(store, event.callId, (tool) => ({ ...tool, status: 'awaiting_approval' }));
      store.update({ approval: prompts.head, queuedApprovals: prompts.queued });
      return;
    }
    case 'tool.permission.resolved':
    case 'tool.permission.cancelled': {
      const settled = dequeue({ head: state.approval, queued: state.queuedApprovals }, (other) => other.approvalId === event.approvalId);
      if (settled === undefined) return;
      store.forget(approvalKey(event.approvalId));
      releaseTool(store, settled.removed.callId);
      store.update({ approval: settled.prompts.head, queuedApprovals: settled.prompts.queued });
      return;
    }
    case 'tool.elicitation.requested': {
      const pending: PendingElicitation = { inputId: event.inputId, callId: event.callId, server: event.server, flow: startFlow(event.requests, event.server), submitted: false };
      const prompts = enqueue({ head: state.elicitation, queued: state.queuedElicitations }, pending, (other) => other.inputId === event.inputId);
      store.name(inputKey(event.inputId), callKey(event.callId));
      updateTool(store, event.callId, (tool) => ({ ...tool, status: 'awaiting_approval' }));
      store.update({ elicitation: prompts.head, queuedElicitations: prompts.queued });
      return;
    }
    case 'tool.elicitation.resolved':
    case 'tool.elicitation.cancelled': {
      const settled = dequeue({ head: state.elicitation, queued: state.queuedElicitations }, (other) => other.inputId === event.inputId);
      if (settled === undefined) return;
      store.forget(inputKey(event.inputId));
      releaseTool(store, settled.removed.callId);
      store.update({ elicitation: settled.prompts.head, queuedElicitations: settled.prompts.queued });
      return;
    }
    case 'mcp.authorization.required':
      appendEntry(store, { kind: 'notice', level: 'warning', text: escapeTerminalLine(mcpAuthorizationNotice(event.server)) });
      return;
    case 'tool.started':
      updateTool(store, event.callId, (tool) => ({ ...tool, status: 'running' }));
      return;
    case 'tool.completed':
      updateTool(store, event.callId, (tool) => ({ ...tool, status: event.status, output: event.output, ...(event.denial === undefined ? {} : { denial: event.denial }) }));
      return;
    case 'hook.completed':
      appendEntry(store, { kind: 'notice', level: hookLevel(event), text: describeHook(event).map(escapeTerminalLine).join('\n') });
      return;
    case 'tool.permission.classified':
      appendEntry(store, { kind: 'notice', level: classificationLevel(event), text: escapeTerminalLine(describeClassification(event, toolOf(store, event.callId)?.title ?? event.callId)) });
      return;
    case 'tool.reconciled':
      updateTool(store, event.callId, (tool) => ({
        ...tool,
        status: event.outcome === 'unknown' ? 'unknown' : event.outcome === 'already_applied' ? 'completed' : 'failed',
        output: event.output,
      }));
      return;
    case 'plan.updated':
      retirePlan(store, { kind: 'retired' });
      appendEntry(store, { kind: 'plan', entries: event.entries }, PLAN_KEY);
      return;
    case 'usage.updated':
      store.update({ usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens } });
      return;
    case 'model.responded':
      store.update({ contextTokens: event.response.usage.total_tokens });
      return;
    case 'context.compacted':
      appendEntry(store, { kind: 'notice', level: 'info', text: 'context compacted' });
      return;
    case 'notice':
      appendEntry(store, { kind: 'notice', level: event.level, text: event.message });
      return;
    case 'tool.loaded':
      appendEntry(store, { kind: 'info', text: `tools loaded: ${event.names.join(', ')}` });
      return;
    case 'tool.waiting':
      store.update({ waiting: event.awaits.kind === 'run' ? `subagent ${event.awaits.agent}` : `job ${event.awaits.jobId}` });
      return;
    case 'attempt.failed':
      store.update({ lastFailure: event });
      return;
    case 'run.status': {
      if (event.to === 'QUEUED' && state.lastFailure !== undefined) {
        const text = describeRetryWait(state.lastFailure);
        store.update({ runStatus: event.to, waiting: text });
        appendEntry(store, { kind: 'notice', level: 'info', text });
        return;
      }
      if (!isTerminalStatus(event.to)) {
        store.update({ runStatus: event.to, waiting: event.to === 'WAITING_TOOL' ? state.waiting : undefined });
        return;
      }
      closeAssistant(store);
      const plan = store.byKey(PLAN_KEY)?.entry;
      if (plan?.kind === 'plan') retirePlan(store, { kind: 'info', text: planText(plan.entries) });
      store.update({
        runStatus: event.to,
        waiting: undefined,
        approval: undefined,
        queuedApprovals: [],
        elicitation: undefined,
        queuedElicitations: [],
        usage: EMPTY_USAGE,
        endedRunsTokens: sessionTokens(state),
      });
      return;
    }
    default:
      return;
  }
};

const withSubagent = (store: TranscriptStore, runId: string, change: (subagent: Subagent) => Subagent): void => {
  const { subagents } = store.state();
  if (subagents.some((subagent) => subagent.runId === runId)) store.update({ subagents: subagents.map((subagent) => (subagent.runId === runId ? change(subagent) : subagent)) });
};

export const subagentStarted = (store: TranscriptStore, agent: string, runId: string, startedAt: number): void => {
  store.update({ subagents: [...store.state().subagents.filter((subagent) => subagent.runId !== runId), { runId, agent, title: undefined, startedAt, awaitingApproval: false }] });
};

export const subagentEnded = (store: TranscriptStore, runId: string): void => {
  store.update({ subagents: store.state().subagents.filter((subagent) => subagent.runId !== runId) });
};

const foldSubagent = (store: TranscriptStore, event: PublicRunEvent): void => {
  switch (event.type) {
    case 'tool.started': {
      const title = toolOf(store, `${event.runId}/${event.callId}`)?.title;
      withSubagent(store, event.runId, (subagent) => ({ ...subagent, title: title === undefined ? subagent.title : title.slice(title.indexOf(': ') + 2) }));
      return;
    }
    case 'tool.permission.requested':
      withSubagent(store, event.runId, (subagent) => ({ ...subagent, awaitingApproval: true }));
      return;
    case 'tool.permission.resolved':
    case 'tool.permission.cancelled':
      withSubagent(store, event.runId, (subagent) => ({ ...subagent, awaitingApproval: false }));
      return;
    default:
      return;
  }
};

export const foldChildEvent = (store: TranscriptStore, event: PublicRunEvent, agent: string): void => {
  const child = asChildEvent(event, agent);
  if (child === undefined) return;
  foldEvent(store, child);
  foldSubagent(store, event);
};

export type ModeCycleInput = ModeAvailability & { current: PermissionMode };

export const nextMode = ({ current, ...availability }: ModeCycleInput): PermissionMode => {
  const available = selectableModes(availability);
  const index = available.indexOf(current);
  const next = available[(index + 1) % available.length];
  if (next === undefined) throw new Error('no permission mode is available to cycle to');
  return next;
};
