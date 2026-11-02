import { isCallToolResult } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { McpInputRequiredError, McpTaskError } from './remote-errors.ts';
import { sanitizeServerText, capText } from './text.ts';
import { pause } from './timers.ts';
import type { McpTimers } from './timers.ts';

export const DEFAULT_TASK_POLL_MS = 1000;
export const MIN_TASK_POLL_MS = 250;
const MAX_TASK_MESSAGE_CHARS = 500;

export type TaskMethod = 'tasks/get' | 'tasks/cancel';

export type TaskRequester = (method: TaskMethod, taskId: string, signal: AbortSignal | undefined) => Promise<unknown>;

type TaskView =
  | { status: 'working'; taskId: string; pollIntervalMs: number | undefined }
  | { status: 'input_required'; taskId: string; pollIntervalMs: number | undefined }
  | { status: 'completed'; taskId: string; pollIntervalMs: number | undefined; result: unknown }
  | { status: 'failed'; taskId: string; pollIntervalMs: number | undefined; error: unknown }
  | { status: 'cancelled'; taskId: string; pollIntervalMs: number | undefined; message: string | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseTask = (value: unknown): TaskView => {
  if (!isRecord(value) || typeof value['taskId'] !== 'string') throw new McpTaskError('', 'the server returned a task without a taskId');
  const taskId = value['taskId'];
  const poll = value['pollIntervalMs'];
  const pollIntervalMs = typeof poll === 'number' && Number.isFinite(poll) ? poll : undefined;
  const status = value['status'];
  if (status === 'working' || status === 'input_required') return { status, taskId, pollIntervalMs };
  if (status === 'completed') return { status, taskId, pollIntervalMs, result: value['result'] };
  if (status === 'failed') return { status, taskId, pollIntervalMs, error: value['error'] };
  if (status === 'cancelled') {
    const message = value['statusMessage'];
    return { status, taskId, pollIntervalMs, message: typeof message === 'string' ? message : undefined };
  }
  throw new McpTaskError(taskId, `the server returned task ${taskId} with an unknown status`);
};

export const pollDelayMs = (hint: number | undefined): number => Math.max(MIN_TASK_POLL_MS, hint ?? DEFAULT_TASK_POLL_MS);

const describeJsonRpcError = (error: unknown): string => {
  if (!isRecord(error)) return 'unknown error';
  const message = typeof error['message'] === 'string' ? error['message'] : 'unknown error';
  return `${capText(sanitizeServerText(message), MAX_TASK_MESSAGE_CHARS)} (code ${String(error['code'])})`;
};

export type SettleTaskOptions = {
  created: unknown;
  request: TaskRequester;
  timers: McpTimers;
  signal: AbortSignal;
};

export const settleTask = async ({ created, request, timers, signal }: SettleTaskOptions): Promise<CallToolResult> => {
  let view = parseTask(created);
  const { taskId } = view;
  for (;;) {
    switch (view.status) {
      case 'completed':
        if (!isCallToolResult(view.result)) throw new McpTaskError(taskId, `task ${taskId} completed with a result that is not a tool result`);
        return view.result;
      case 'failed':
        throw new McpTaskError(taskId, `task ${taskId} failed: ${describeJsonRpcError(view.error)}`);
      case 'cancelled':
        throw new McpTaskError(taskId, `task ${taskId} was cancelled by the server${view.message === undefined ? '' : `: ${capText(sanitizeServerText(view.message), MAX_TASK_MESSAGE_CHARS)}`}`);
      case 'input_required':
        await request('tasks/cancel', taskId, undefined);
        throw new McpInputRequiredError(`task ${taskId} needs user input, which this client does not support; the task was cancelled`);
      case 'working':
        break;
    }
    await pause(timers, pollDelayMs(view.pollIntervalMs), signal);
    if (signal.aborted) {
      await request('tasks/cancel', taskId, undefined);
      throw signal.reason;
    }
    try {
      view = parseTask(await request('tasks/get', taskId, signal));
    } catch (error) {
      if (!signal.aborted) throw error;
      await request('tasks/cancel', taskId, undefined);
      throw signal.reason;
    }
  }
};
