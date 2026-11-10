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
  | { kind: 'thought'; itemId: string; text: string; startedAt: number; endedAt?: number; expanded: boolean; window: number }
  | { kind: 'tool'; callId: string; name: string; title: string; toolKind: ToolKind; rawInput: unknown; status: ToolStatus; output?: string; denial?: PermissionDenial }
  | { kind: 'plan'; entries: readonly PlanEntry[] }
  | { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'retired' };

export type ToolEntry = Extract<Entry, { kind: 'tool' }>;

export type PendingApproval = { approvalId: string; callId: string; options: readonly PermissionOption[]; reason: string; suggestedRule?: string };

export type PendingElicitation = { inputId: string; callId: string; server: string; flow: ElicitationFlow; submitted: boolean };

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type PhaseKind = 'queued' | 'model' | 'thinking' | 'responding' | 'tool' | 'classifying' | 'hook' | 'compacting' | 'retry' | 'awaited';

export type RunPhase = { kind: PhaseKind; text: string; startedAt: number };

export type RunningTool = { callId: string; title: string; startedAt: number };

export type Subagent = { runId: string; agent: string; title: string | undefined; startedAt: number; awaitingApproval: boolean };

export const BANNER_KEY = 'banner';
const PLAN_KEY = 'plan';
const itemKey = (itemId: string): string => `item:${itemId}`;
const thoughtKey = (itemId: string): string => `thought:${itemId}`;
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

const closeThought = (store: TranscriptStore, endedAt: number): void => {
  const open = store.state().openThought;
  if (open === undefined) return;
  store.change(open, (entry) => (entry.kind === 'thought' ? { ...entry, endedAt } : entry));
  store.update({ openThought: undefined });
};

export const toggleThought = (store: TranscriptStore, itemId: string): void => {
  store.change(thoughtKey(itemId), (entry) => (entry.kind === 'thought' ? { ...entry, expanded: !entry.expanded } : entry));
};

export const toggleNewestThought = (store: TranscriptStore): void => {
  const newest = store.state().newestThought;
  if (newest !== undefined) store.change(newest, (entry) => (entry.kind === 'thought' ? { ...entry, expanded: !entry.expanded } : entry));
};

export const thoughtWindowOf = (viewportRows: number): number => Math.ceil(viewportRows / 3);

export const setThoughtWindow = (store: TranscriptStore, window: number): void => {
  const state = store.state();
  if (state.thoughtWindow === window) return;
  store.update({ thoughtWindow: window });
  if (state.openThought !== undefined) store.change(state.openThought, (entry) => (entry.kind === 'thought' ? { ...entry, window } : entry));
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

const foldEntries = (store: TranscriptStore, event: PublicRunEvent): void => {
  const state = store.state();
  switch (event.type) {
    case 'agent.thought.delta': {
      const key = thoughtKey(event.itemId);
      if (store.byKey(key) !== undefined) {
        store.change(key, (entry) => (entry.kind === 'thought' ? { ...entry, text: entry.text + event.text } : entry));
        return;
      }
      appendEntry(store, { kind: 'thought', itemId: event.itemId, text: event.text, startedAt: event.createdAt, expanded: false, window: state.thoughtWindow }, key);
      store.update({ openThought: key, newestThought: key });
      return;
    }
    case 'agent.message.delta': {
      closeThought(store, event.createdAt);
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
      closeThought(store, event.createdAt);
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
      store.update({ contextTokens: event.response.usage.total_tokens, ...(event.target === undefined ? {} : { answeringTarget: event.target }) });
      if (event.target !== undefined && state.answeringTarget !== undefined && state.answeringTarget !== event.target)
        appendEntry(store, { kind: 'info', text: `model changed: ${state.answeringTarget} -> ${event.target}` });
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
    case 'attempt.failed':
      store.update({ lastFailure: event });
      return;
    case 'run.status': {
      if (!isTerminalStatus(event.to)) {
        store.update({ runStatus: event.to });
        return;
      }
      closeThought(store, event.createdAt);
      closeAssistant(store);
      const plan = store.byKey(PLAN_KEY)?.entry;
      if (plan?.kind === 'plan') retirePlan(store, { kind: 'info', text: planText(plan.entries) });
      store.update({
        runStatus: event.to,
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

export const WAITING_FOR_MODEL = 'waiting for the model';

const toolsPhase = (tools: readonly RunningTool[]): RunPhase | undefined => {
  const newest = tools.at(-1);
  if (newest === undefined) return undefined;
  return { kind: 'tool', text: `running ${newest.title}${tools.length > 1 ? ` +${tools.length - 1}` : ''}`, startedAt: newest.startedAt };
};

const awaitedText = (awaits: Extract<PublicRunEvent, { type: 'tool.waiting' }>['awaits']): string => (awaits.kind === 'run' ? `waiting for subagent ${awaits.agent}` : `waiting for job ${awaits.jobId}`);

const foldPhase = (store: TranscriptStore, event: PublicRunEvent): void => {
  const state = store.state();
  const startedAt = event.createdAt;
  const begin = (kind: PhaseKind, text: string): void => store.update({ phase: { kind, text, startedAt } });
  const withTools = (runningTools: readonly RunningTool[]): void => store.update({ runningTools, phase: toolsPhase(runningTools) });
  switch (event.type) {
    case 'model.requested':
    case 'model.stream.restarted':
      begin('model', WAITING_FOR_MODEL);
      return;
    case 'agent.thought.delta':
      if (state.phase?.kind !== 'thinking') begin('thinking', 'thinking');
      return;
    case 'agent.message.delta':
      if (state.phase?.kind !== 'responding') begin('responding', 'responding');
      return;
    case 'tool.call':
      withTools([...state.runningTools, { callId: event.callId, title: event.title, startedAt }]);
      return;
    case 'tool.completed':
    case 'tool.reconciled':
      withTools(state.runningTools.filter((tool) => tool.callId !== event.callId));
      return;
    case 'tool.permission.classifying':
      begin('classifying', 'checking this call');
      return;
    case 'hook.started':
      begin('hook', `running hook ${event.event}`);
      return;
    case 'context.compacting':
      begin('compacting', 'compacting the conversation');
      return;
    case 'tool.waiting':
      begin('awaited', awaitedText(event.awaits));
      return;
    case 'tool.permission.classified':
    case 'hook.completed':
    case 'context.compacted':
    case 'context.compaction_rejected':
    case 'model.responded':
    case 'model.rejected':
      withTools(state.runningTools);
      return;
    case 'attempt.failed':
    case 'attempt.lost':
      withTools([]);
      return;
    case 'run.status':
      if (isTerminalStatus(event.to)) withTools([]);
      else if (event.to === 'RUNNING') withTools(state.runningTools);
      else if (event.to === 'QUEUED' && state.lastFailure !== undefined) store.update({ lastFailure: undefined, phase: { kind: 'retry', text: describeRetryWait(state.lastFailure), startedAt } });
      else if (event.to === 'QUEUED') begin('queued', WAITING_FOR_MODEL);
      return;
    default:
      return;
  }
};

export const foldEvent = (store: TranscriptStore, event: PublicRunEvent): void => {
  foldEntries(store, event);
  foldPhase(store, event);
};

export const runCreated = (store: TranscriptStore, runId: string, startedAt: number): void => {
  store.update({ runId, runStatus: 'QUEUED', phase: { kind: 'queued', text: WAITING_FOR_MODEL, startedAt } });
};

export const runLeft = (store: TranscriptStore): void => {
  store.update({ phase: undefined, runningTools: [] });
};

export const shownRunPhase = (state: Pick<TranscriptState, 'phase' | 'approval' | 'elicitation'>): RunPhase | undefined => (state.approval !== undefined || state.elicitation !== undefined ? undefined : state.phase);

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
  foldEntries(store, child);
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
