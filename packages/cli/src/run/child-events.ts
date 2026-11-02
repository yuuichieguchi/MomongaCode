import type { PublicRunEvent } from '@momonga/protocol';

const qualified = (runId: string, callId: string): string => `${runId}/${callId}`;

export const asChildEvent = (event: PublicRunEvent, agent: string): PublicRunEvent | undefined => {
  switch (event.type) {
    case 'tool.call':
      return { ...event, callId: qualified(event.runId, event.callId), title: `${agent}: ${event.title}` };
    case 'tool.permission.requested':
    case 'tool.elicitation.requested':
    case 'tool.started':
    case 'tool.updated':
    case 'tool.completed':
    case 'tool.reconciled':
      return { ...event, callId: qualified(event.runId, event.callId) };
    case 'tool.permission.resolved':
    case 'tool.permission.cancelled':
    case 'tool.elicitation.resolved':
    case 'tool.elicitation.cancelled':
    case 'mcp.authorization.required':
      return event;
    default:
      return undefined;
  }
};
