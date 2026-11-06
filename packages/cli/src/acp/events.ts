import type { ContentBlock, PermissionOption, SessionUpdate, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { isRecord } from '@momonga/foundation';
import type { ElicitationRequestView, PublicRunEvent } from '@momonga/protocol';
import { classificationLevel, describeClassification, describeDenial, describeHook, hookLevel } from '../policy-messages.ts';
import { asChildEvent } from '../run/child-events.ts';

export type ClientFeatures = {
  readonly notices: boolean;
  readonly compaction: boolean;
  readonly elicitation: { readonly form: boolean; readonly url: boolean };
};

export type Phase = 'history' | 'live';

export type Effect =
  | { readonly kind: 'update'; readonly update: SessionUpdate }
  | { readonly kind: 'usage'; readonly used: number }
  | { readonly kind: 'model'; readonly modelAlias: string }
  | { readonly kind: 'permission'; readonly approvalId: string; readonly toolCall: ToolCallUpdate; readonly options: readonly PermissionOption[] }
  | {
      readonly kind: 'elicitation';
      readonly inputId: string;
      readonly toolCallId: string;
      readonly server: string;
      readonly requests: readonly ElicitationRequestView[];
    }
  | { readonly kind: 'withdraw'; readonly id: string };

export type MapperState = { readonly calls: Map<string, ToolCall>; contextTokens: number | undefined };

export const createMapperState = (): MapperState => ({ calls: new Map(), contextTokens: undefined });

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

const awaitedText = (awaits: Extract<PublicRunEvent, { type: 'tool.waiting' }>['awaits']): string =>
  awaits.kind === 'run' ? `waiting for subagent ${awaits.agent}` : `waiting for job ${awaits.jobId}`;

export const mapChildEvent = (event: PublicRunEvent, agent: string, state: MapperState, features: ClientFeatures): Effect[] => {
  const child = asChildEvent(event, agent);
  return child === undefined ? [] : mapRunEvent(child, 'live', state, features);
};

export const mapRunEvent = (event: PublicRunEvent, phase: Phase, state: MapperState, features: ClientFeatures): Effect[] => {
  switch (event.type) {
    case 'user.message':
      return phase === 'history' ? [message('user_message_chunk', messageIdOf(event.runId, 'user'), event.text)] : [];
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
      return [{ kind: 'permission', approvalId: event.approvalId, toolCall: { ...toolCall, status: 'pending' }, options: event.options }];
    }
    case 'tool.permission.resolved':
    case 'tool.permission.cancelled':
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
    case 'tool.completed':
      return [
        toolUpdate(toolCallIdOf(event.runId, event.callId), {
          status: event.status,
          content:
            event.denial !== undefined
              ? outputContent(describeDenial(event.denial))
              : event.content === undefined
                ? outputContent(event.output)
                : toolContentOf(event.content),
          rawOutput: event.output,
        }),
      ];
    case 'tool.reconciled':
      return [
        toolUpdate(toolCallIdOf(event.runId, event.callId), { status: reconciledStatus(event.outcome), content: outputContent(event.output), rawOutput: event.output }),
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
      return phase === 'live' ? [{ kind: 'model', modelAlias: event.modelAlias }] : [];
    case 'run.started':
    case 'run.status':
    case 'model.requested':
    case 'model.stream.restarted':
    case 'context.inherited':
    case 'context.truncated':
    case 'instructions.loaded':
    case 'skill.activated':
    case 'tool.loaded':
    case 'tool.offered':
    case 'loop.warned':
    case 'meter.observed':
    case 'model.rejected':
    case 'approval.rule.persisted':
    case 'job.finished':
    case 'attempt.failed':
    case 'attempt.lost':
    case 'usage.charged':
    case 'context.governing_loaded':
    case 'context.memories_loaded':
    case 'context.contribution':
      return [];
    case 'hook.completed':
      return phase === 'live' ? liveNotice(features, event.runId, event.seq, hookLevel(event), describeHook(event).join('\n')) : [];
    case 'tool.permission.classified': {
      const subject = state.calls.get(toolCallIdOf(event.runId, event.callId))?.title ?? event.callId;
      return phase === 'live' ? liveNotice(features, event.runId, event.seq, classificationLevel(event), describeClassification(event, subject)) : [];
    }
  }
};
