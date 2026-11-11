import type { PublicRunEvent } from '@momonga/protocol';

export const noEventTypeLeft = (_event: never): undefined => undefined;

const qualified = (runId: string, callId: string): string => `${runId}/${callId}`;

export const asChildEvent = (event: PublicRunEvent, agent: string): PublicRunEvent | undefined => {
  switch (event.type) {
    case 'tool.call':
      return { ...event, callId: qualified(event.runId, event.callId), title: `${agent}: ${event.title}` };
    case 'hook.completed':
      return event.callId === undefined ? event : { ...event, callId: qualified(event.runId, event.callId) };
    case 'tool.permission.classified':
    case 'tool.permission.requested':
    case 'tool.elicitation.requested':
    case 'tool.started':
    case 'tool.updated':
    case 'tool.completed':
    case 'tool.reconciled':
      return { ...event, callId: qualified(event.runId, event.callId) };
    case 'tool.unknown.requested':
      return { ...event, callIds: event.callIds.map((callId) => qualified(event.runId, callId)) };
    case 'tool.unknown.resolved':
    case 'tool.unknown.cancelled':
    case 'tool.permission.resolved':
    case 'tool.permission.cancelled':
    case 'tool.elicitation.resolved':
    case 'tool.elicitation.cancelled':
    case 'mcp.authorization.required':
      return event;
    case 'user.message':
    case 'run.started':
    case 'attempt.failed':
    case 'attempt.lost':
    case 'run.status':
    case 'model.requested':
    case 'model.responded':
    case 'agent.message.delta':
    case 'agent.thought.delta':
    case 'model.stream.restarted':
    case 'tool.permission.classifying':
    case 'hook.started':
    case 'verification.started':
    case 'verification.completed':
    case 'tool.loaded':
    case 'tool.offered':
    case 'loop.warned':
    case 'budget.exhausted':
    case 'tool.held':
    case 'tool.held.resolved':
    case 'run.quiescent':
    case 'model.rejected':
    case 'meter.observed':
    case 'tool.waiting':
    case 'job.finished':
    case 'plan.updated':
    case 'mode.changed':
    case 'model.changed':
    case 'inbox.changed':
    case 'user_shell':
    case 'usage.updated':
    case 'usage.charged':
    case 'context.compacted':
    case 'context.governing_loaded':
    case 'context.memories_loaded':
    case 'context.contribution':
    case 'context.compacting':
    case 'context.compaction_rejected':
    case 'context.inherited':
    case 'context.truncated':
    case 'instructions.loaded':
    case 'skill.activated':
    case 'approval.rule.persisted':
    case 'user.compact':
    case 'notice':
      return undefined;
    default:
      return noEventTypeLeft(event);
  }
};
