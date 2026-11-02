import type { CallToolResult } from '@modelcontextprotocol/client';
import { parseInputRequests } from './input-requests.ts';
import type { ElicitationAnswer } from './input-requests.ts';
import { McpTaskError } from './remote-errors.ts';
import { McpInputSuspension } from './suspension.ts';
import type { McpCheckpoint } from './suspension.ts';
import { sanitizeServerText, capText } from './text.ts';
import { pause } from './timers.ts';
import type { McpTimers } from './timers.ts';

export const DEFAULT_TASK_POLL_MS = 1000;
export const MIN_TASK_POLL_MS = 250;
const MAX_TASK_MESSAGE_CHARS = 500;

export type TaskMethod = 'tasks/get' | 'tasks/update' | 'tasks/cancel';

export type TaskParams = { taskId: string; inputResponses?: Record<string, ElicitationAnswer> };

export type TaskRequester = (method: TaskMethod, params: TaskParams, signal: AbortSignal | undefined) => Promise<unknown>;

type TaskView =
  | { status: 'working'; taskId: string; pollIntervalMs: number | undefined }
  | { status: 'input_required'; taskId: string; pollIntervalMs: number | undefined; inputRequests: unknown }
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
  if (status === 'working') return { status, taskId, pollIntervalMs };
  if (status === 'input_required') return { status, taskId, pollIntervalMs, inputRequests: value['inputRequests'] };
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
  start: { created: unknown } | { taskId: string; answered: readonly string[] };
  answers: Record<string, ElicitationAnswer>;
  request: TaskRequester;
  timers: McpTimers;
  signal: AbortSignal;
  onCheckpoint(checkpoint: McpCheckpoint): void;
  accept(taskId: string, result: unknown): CallToolResult;
};

export const settleTask = async ({ start, answers, request, timers, signal, onCheckpoint, accept }: SettleTaskOptions): Promise<CallToolResult> => {
  const answered = new Set<string>('answered' in start ? start.answered : []);
  const checkpoint = (taskId: string): McpCheckpoint => ({ kind: 'task', taskId, answered: [...answered] });
  const cancel = (taskId: string): Promise<unknown> => request('tasks/cancel', { taskId }, undefined);
  let view: TaskView;
  if ('created' in start) {
    view = parseTask(start.created);
    onCheckpoint(checkpoint(view.taskId));
  } else {
    view = parseTask(await request('tasks/get', { taskId: start.taskId }, signal));
  }
  const { taskId } = view;
  for (;;) {
    switch (view.status) {
      case 'completed':
        return accept(taskId, view.result);
      case 'failed':
        throw new McpTaskError(taskId, `task ${taskId} failed: ${describeJsonRpcError(view.error)}`);
      case 'cancelled':
        throw new McpTaskError(taskId, `task ${taskId} was cancelled by the server${view.message === undefined ? '' : `: ${capText(sanitizeServerText(view.message), MAX_TASK_MESSAGE_CHARS)}`}`);
      case 'input_required': {
        let requests;
        try {
          requests = parseInputRequests(view.inputRequests);
        } catch (error) {
          await cancel(taskId);
          throw error;
        }
        const fresh = requests.filter((entry) => !answered.has(entry.key));
        if (fresh.length > 0) {
          const missing = fresh.filter((entry) => answers[entry.key] === undefined);
          if (missing.length > 0) throw new McpInputSuspension(missing, checkpoint(taskId));
          await request('tasks/update', { taskId, inputResponses: Object.fromEntries(fresh.map((entry) => [entry.key, answers[entry.key] as ElicitationAnswer])) }, signal);
          for (const entry of fresh) answered.add(entry.key);
          onCheckpoint(checkpoint(taskId));
        }
        break;
      }
      case 'working':
        break;
    }
    await pause(timers, pollDelayMs(view.pollIntervalMs), signal);
    if (signal.aborted) {
      await cancel(taskId);
      throw signal.reason;
    }
    try {
      view = parseTask(await request('tasks/get', { taskId }, signal));
    } catch (error) {
      if (!signal.aborted) throw error;
      await cancel(taskId);
      throw signal.reason;
    }
  }
};
