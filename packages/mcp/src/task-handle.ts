import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { isRecord } from '@momonga/foundation';

export const TASK_HANDLE_ERROR_CODE = -39001;

type RequestId = string | number;

export const taskHandleOf = (code: unknown, data: unknown): Record<string, unknown> | undefined =>
  code === TASK_HANDLE_ERROR_CODE && isRecord(data) && data['resultType'] === 'task' ? data : undefined;

export type TaskHandleRewriter = {
  outbound(message: JSONRPCMessage): void;
  inbound(message: JSONRPCMessage): JSONRPCMessage;
  reset(): void;
};

export const createTaskHandleRewriter = (): TaskHandleRewriter => {
  const toolCalls = new Set<RequestId>();
  return {
    outbound: (message) => {
      if ('method' in message && 'id' in message && message.method === 'tools/call') toolCalls.add(message.id);
      if ('method' in message && !('id' in message) && message.method === 'notifications/cancelled') {
        const requestId = isRecord(message.params) ? message.params['requestId'] : undefined;
        if (typeof requestId === 'string' || typeof requestId === 'number') toolCalls.delete(requestId);
      }
    },
    inbound: (message) => {
      if ('method' in message || !('id' in message) || message.id === undefined) return message;
      const tracked = toolCalls.delete(message.id);
      if (!tracked || !('result' in message)) return message;
      const result: unknown = message.result;
      if (!isRecord(result) || result['resultType'] !== 'task') return message;
      // SDK 2.4.0 rejects any tools/call result whose resultType is "task" with UnsupportedResultType and drops the handle; surfacing it as an error carries the handle through the client.
      return { jsonrpc: '2.0', id: message.id, error: { code: TASK_HANDLE_ERROR_CODE, message: 'the server returned a task handle', data: result } };
    },
    reset: () => toolCalls.clear(),
  };
};
