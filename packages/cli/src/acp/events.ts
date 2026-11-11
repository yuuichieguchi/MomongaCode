import type { ContentBlock, PermissionOption, SessionUpdate, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { isRecord } from '@momonga/foundation';
import { approvalShownLines, heldEndOf, isOpaqueEvent, unknownEffectLines, unknownEffectTitle } from '@momonga/protocol';
import type { ElicitationRequestView, PublicRunEvent, PublicStreamEvent } from '@momonga/protocol';
import { classificationLevel, describeClassification, describeDenial, describeHook, describeVerification, hookLevel, verificationLevel } from '../policy-messages.ts';
import { describeRetryWait } from '../retry-wait.ts';
import { asChildEvent } from '../run/child-events.ts';
import { isPrompt } from '../run/prompt-event.ts';

export type ClientFeatures = {
  readonly notices: boolean;
  readonly compaction: boolean;
  readonly elicitation: { readonly form: boolean; readonly url: boolean };
};

export type Phase = 'history' | 'live';

export type Effect =
  | { readonly kind: 'update'; readonly update: SessionUpdate }
  | { readonly kind: 'usage'; readonly used: number }
  | { readonly kind: 'model'; readonly model: string }
  | { readonly kind: 'permission'; readonly approvalId: string; readonly toolCall: ToolCallUpdate; readonly options: readonly PermissionOption[] }
  | {
      readonly kind: 'elicitation';
      readonly inputId: string;
      readonly toolCallId: string;
      readonly server: string;
      readonly requests: readonly ElicitationRequestView[];
    }
  | { readonly kind: 'withdraw'; readonly id: string };

export type MapperState = {
  readonly calls: Map<string, ToolCall>;
  readonly found: Map<string, string>;
  readonly firstSeq: Map<string, number>;
  readonly held: Map<string, { approvalId: string; reason: string }>;
  readonly opaqueTypes: Set<string>;
  contextTokens: number | undefined;
  lastFailure: Extract<PublicRunEvent, { type: 'attempt.failed' }> | undefined;
};

export const createMapperState = (): MapperState => ({ calls: new Map(), found: new Map(), firstSeq: new Map(), held: new Map(), opaqueTypes: new Set(), contextTokens: undefined, lastFailure: undefined });

export class UnsupportedToolContent extends Error {
  constructor(detail: string) {
    super(`a tool reported content that is not an ACP tool call content block: ${detail}`);
    this.name = 'UnsupportedToolContent';
  }
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

const toolContentItem = (item: unknown): ToolCallContent => {
  if (isRecord(item) && item['type'] === 'content' && isRecord(item['content']) && item['content']['type'] === 'text' && typeof item['content']['text'] === 'string') {
    return { type: 'content', content: textBlock(item['content']['text']) };
  }
  if (isRecord(item) && item['type'] === 'diff' && typeof item['path'] === 'string' && typeof item['newText'] === 'string') {
    const oldText = item['oldText'];
    if (oldText === null || typeof oldText === 'string') return { type: 'diff', path: item['path'], oldText, newText: item['newText'] };
  }
  throw new UnsupportedToolContent(JSON.stringify(item));
};

export const toolContentOf = (items: readonly unknown[]): ToolCallContent[] => items.map(toolContentItem);

const hunkSide = (lines: readonly string[], absent: '+' | '-'): string | null => {
  const kept = lines.filter((line) => !line.startsWith(absent));
  return kept.length === 0 ? null : kept.map((line) => `${line.slice(1)}\n`).join('');
};

type ChangeRecord = Pick<Extract<PublicRunEvent, { type: 'tool.completed' }>, 'files' | 'hunks'>;

const diffContentOf = ({ files, hunks }: ChangeRecord): ToolCallContent[] | undefined => {
  const written = files?.find((file) => file.access === 'write');
  if (written === undefined || hunks === undefined || hunks.length === 0) return undefined;
  return hunks.map((hunk) => ({ type: 'diff', path: written.path, oldText: hunkSide(hunk.lines, '+'), newText: hunkSide(hunk.lines, '-') ?? '' }));
};

export const toolCallIdOf = (runId: string, callId: string): string => `${runId}/${callId}`;

const messageIdOf = (runId: string, itemId: string): string => `${runId}/${itemId}`;

const message = (sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk', messageId: string, text: string): Effect => ({
  kind: 'update',
  update: { sessionUpdate, content: textBlock(text), messageId },
});

const toolUpdate = (toolCallId: string, change: Omit<ToolCallUpdate, 'toolCallId'>): Effect => ({
  kind: 'update',
  update: { sessionUpdate: 'tool_call_update', toolCallId, ...change },
});

const outputContent = (output: string): ToolCallContent[] => [{ type: 'content', content: textBlock(output) }];

const reconciledStatus = (outcome: 'already_applied' | 'not_applied' | 'unknown'): ToolCallStatus => (outcome === 'already_applied' ? 'completed' : 'failed');

export const noticeUpdate = (features: ClientFeatures, messageId: string, level: 'info' | 'warning' | 'error', text: string): SessionUpdate =>
  features.notices
    ? { sessionUpdate: 'notice', severity: level, title: text }
    : { sessionUpdate: 'agent_message_chunk', content: textBlock(`momonga ${level}: ${text}\n`), messageId };

const liveNotice = (features: ClientFeatures, runId: string, seq: number, level: 'info' | 'warning' | 'error', text: string): Effect[] => [
  { kind: 'update', update: noticeUpdate(features, `${runId}/notice/${seq}`, level, text) },
];

const HELD_GOES_ON = 'The run goes on with other work.';
const HELD_QUIESCENT = 'The run waits for a person: nothing else can proceed.';

const heldText = (approvalId: string, reason: string, state: string): string => `Held for approval (${approvalId}): ${reason}. ${state}`;

const heldUpdate = (toolCallId: string, held: { approvalId: string; reason: string }, state: string): Effect => toolUpdate(toolCallId, { status: 'pending', content: outputContent(heldText(held.approvalId, held.reason, state)) });

const awaitedText = (awaits: Extract<PublicRunEvent, { type: 'tool.waiting' }>['awaits']): string =>
  awaits.kind === 'run' ? `waiting for subagent ${awaits.agent}` : `waiting for job ${awaits.jobId}`;

const skipOpaque = (event: PublicStreamEvent, state: MapperState): event is Extract<PublicStreamEvent, { opaque: true }> => {
  if (!isOpaqueEvent(event)) return false;
  state.opaqueTypes.add(event.type);
  return true;
};

export const mapChildEvent = (event: PublicStreamEvent, agent: string, state: MapperState, features: ClientFeatures): Effect[] => {
  if (skipOpaque(event, state)) return [];
  const child = asChildEvent(event, agent);
  return child === undefined ? [] : mapRunEvent(child, 'live', state, features);
};

export const mapRunEvent = (event: PublicStreamEvent, phase: Phase, state: MapperState, features: ClientFeatures): Effect[] => {
  if (skipOpaque(event, state)) return [];
  return mapKnownEvent(event, phase, state, features);
};

const mapKnownEvent = (event: PublicRunEvent, phase: Phase, state: MapperState, features: ClientFeatures): Effect[] => {
  if ('seq' in event && !state.firstSeq.has(event.runId)) state.firstSeq.set(event.runId, event.seq);
  const ended = heldEndOf(event);
  if (ended !== undefined && 'runId' in event) state.held.delete(toolCallIdOf(event.runId, ended.callId));
  switch (event.type) {
    case 'user.message':
      return phase === 'history' && isPrompt(event, state.firstSeq.get(event.runId)) ? [message('user_message_chunk', messageIdOf(event.runId, 'user'), event.text)] : [];
    case 'agent.message.delta':
      return [message('agent_message_chunk', messageIdOf(event.runId, event.itemId), event.text)];
    case 'agent.thought.delta':
      return [message('agent_thought_chunk', messageIdOf(event.runId, event.itemId), event.text)];
    case 'tool.call': {
      const toolCallId = toolCallIdOf(event.runId, event.callId);
      const locations = event.locations?.map(({ path, line }) => (line === undefined ? { path } : { path, line }));
      const call: ToolCall = {
        toolCallId,
        title: event.title,
        name: event.name,
        kind: event.kind,
        status: 'pending',
        rawInput: event.rawInput,
        ...(locations === undefined ? {} : { locations }),
      };
      state.calls.set(toolCallId, call);
      return [{ kind: 'update', update: { sessionUpdate: 'tool_call', ...call } }];
    }
    case 'tool.permission.requested': {
      const toolCallId = toolCallIdOf(event.runId, event.callId);
      const toolCall = state.calls.get(toolCallId);
      if (toolCall === undefined) throw new Error(`approval ${event.approvalId} asks about call ${event.callId}, which no tool.call event announced`);
      const lines = approvalShownLines(event.shown);
      const shownCall = { ...toolCall, status: 'pending' as const, rawInput: event.shown.input, ...(lines.length === 0 ? {} : { content: outputContent(lines.join('\n')) }) };
      return [{ kind: 'permission', approvalId: event.approvalId, toolCall: shownCall, options: event.options }];
    }
    case 'tool.unknown.requested': {
      const asked = event.callIds.map((callId) => {
        const toolCallId = toolCallIdOf(event.runId, callId);
        const toolCall = state.calls.get(toolCallId);
        if (toolCall === undefined) throw new Error(`approval ${event.approvalId} asks about call ${callId}, which no tool.call event announced`);
        const found = state.found.get(toolCallId);
        return { toolCall, text: { title: toolCall.title, ...(found === undefined ? {} : { found }) } };
      });
      const [first] = asked;
      if (first === undefined) throw new Error(`approval ${event.approvalId} asks about no call`);
      const texts = asked.map((entry) => entry.text);
      return [
        {
          kind: 'permission',
          approvalId: event.approvalId,
          toolCall: { ...first.toolCall, status: 'pending', title: unknownEffectTitle(texts), content: outputContent(unknownEffectLines(texts).join('\n')) },
          options: event.options,
        },
      ];
    }
    case 'tool.permission.resolved':
    case 'tool.permission.cancelled':
    case 'tool.unknown.resolved':
    case 'tool.unknown.cancelled':
      return [{ kind: 'withdraw', id: event.approvalId }];
    case 'tool.elicitation.requested':
      return [{ kind: 'elicitation', inputId: event.inputId, toolCallId: toolCallIdOf(event.runId, event.callId), server: event.server, requests: event.requests }];
    case 'tool.elicitation.resolved':
    case 'tool.elicitation.cancelled':
      return [{ kind: 'withdraw', id: event.inputId }];
    case 'tool.started':
      return [toolUpdate(toolCallIdOf(event.runId, event.callId), { status: 'in_progress' })];
    case 'tool.updated':
      return [toolUpdate(toolCallIdOf(event.runId, event.callId), { content: toolContentOf(event.content) })];
    case 'tool.held': {
      const toolCallId = toolCallIdOf(event.runId, event.callId);
      const held = { approvalId: event.approvalId, reason: event.reason };
      state.held.set(toolCallId, held);
      return [heldUpdate(toolCallId, held, HELD_GOES_ON)];
    }
    case 'tool.held.resolved':
      return [toolUpdate(toolCallIdOf(event.runId, event.callId), { status: event.status, content: outputContent(event.output), rawOutput: event.output })];
    case 'run.quiescent':
      return event.held.map((entry) => heldUpdate(toolCallIdOf(event.runId, entry.callId), { approvalId: entry.approvalId, reason: entry.reason }, HELD_QUIESCENT));
    case 'tool.completed': {
      const waiting = event.denial?.source === 'held' ? state.held.get(toolCallIdOf(event.runId, event.callId)) : undefined;
      if (waiting !== undefined) return [heldUpdate(toolCallIdOf(event.runId, event.callId), waiting, HELD_GOES_ON)];
      return [
        toolUpdate(toolCallIdOf(event.runId, event.callId), {
          status: event.status,
          content:
            event.denial !== undefined
              ? outputContent(describeDenial(event.denial))
              : event.content === undefined
                ? (diffContentOf(event) ?? outputContent(event.output))
                : toolContentOf(event.content),
          rawOutput: event.output,
        }),
      ];
    }
    case 'tool.reconciled':
      state.found.set(toolCallIdOf(event.runId, event.callId), event.output);
      return [
        toolUpdate(toolCallIdOf(event.runId, event.callId), { status: reconciledStatus(event.outcome), content: diffContentOf(event) ?? outputContent(event.output), rawOutput: event.output }),
      ];
    case 'plan.updated':
      return [{ kind: 'update', update: { sessionUpdate: 'plan', entries: event.entries.map(({ content, priority, status }) => ({ content, priority, status })) } }];
    case 'model.responded':
      state.contextTokens = event.response.usage.total_tokens;
      return [];
    case 'usage.updated': {
      if (state.contextTokens === undefined) throw new Error(`run ${event.runId} reported usage before any model response`);
      return [{ kind: 'usage', used: state.contextTokens }];
    }
    case 'context.compacted':
      return features.compaction
        ? [
            {
              kind: 'update',
              update: { sessionUpdate: 'compaction_update', compactionId: `${event.runId}/${event.seq}`, status: 'completed', summary: [textBlock(event.summary)] },
            },
          ]
        : [];
    case 'context.inherited_compacted':
      return [];
    case 'context.compaction_rejected':
      return features.compaction
        ? [
            {
              kind: 'update',
              update: {
                sessionUpdate: 'compaction_update',
                compactionId: `${event.runId}/${event.seq}`,
                status: 'failed',
                error: 'the compaction summary was rejected',
              },
            },
          ]
        : [];
    case 'notice':
      return phase === 'live' ? liveNotice(features, event.runId, event.seq, event.level, event.message) : [];
    case 'mcp.authorization.required':
      return phase === 'live' ? liveNotice(features, event.runId, event.seq, 'warning', `MCP server ${event.server} needs authorization`) : [];
    case 'tool.waiting':
      return [toolUpdate(toolCallIdOf(event.runId, event.callId), { status: 'in_progress', content: outputContent(awaitedText(event.awaits)) })];
    case 'mode.changed':
      return phase === 'live' ? [{ kind: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: event.mode } }] : [];
    case 'model.changed':
      return phase === 'live' ? [{ kind: 'model', model: event.model }] : [];
    case 'inbox.changed':
    case 'user_shell':
      return [];
    case 'attempt.failed':
      state.lastFailure = event;
      return [];
    case 'run.status':
      return phase === 'live' && event.to === 'QUEUED' && state.lastFailure !== undefined
        ? liveNotice(features, event.runId, event.seq, 'info', describeRetryWait(state.lastFailure))
        : [];
    case 'run.started':
    case 'model.requested':
    case 'model.stream.restarted':
    case 'context.inherited':
    case 'context.truncated':
    case 'instructions.loaded':
    case 'skill.activated':
    case 'tool.loaded':
    case 'tool.offered':
    case 'loop.warned':
    case 'budget.exhausted':
    case 'meter.observed':
    case 'model.rejected':
    case 'approval.rule.persisted':
    case 'job.finished':
    case 'attempt.lost':
    case 'usage.charged':
    case 'context.governing_loaded':
    case 'context.memories_loaded':
    case 'context.contribution':
    case 'context.compacting':
    case 'tool.permission.classifying':
    case 'hook.started':
    case 'verification.started':
      return [];
    case 'verification.completed':
      return phase === 'live' ? liveNotice(features, event.runId, event.seq, verificationLevel(event), describeVerification(event)) : [];
    case 'hook.completed':
      return phase === 'live' ? liveNotice(features, event.runId, event.seq, hookLevel(event), describeHook(event).join('\n')) : [];
    case 'tool.permission.classified': {
      const subject = state.calls.get(toolCallIdOf(event.runId, event.callId))?.title ?? event.callId;
      return phase === 'live' ? liveNotice(features, event.runId, event.seq, classificationLevel(event), describeClassification(event, subject)) : [];
    }
  }
};
