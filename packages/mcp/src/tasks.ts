import type { CallToolResult } from '@modelcontextprotocol/client';
import { isRecord } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { McpInputProtocolError, parseInputRequests } from './input-requests.ts';
import type { ElicitationAnswer } from './input-requests.ts';
import { McpTaskError } from './remote-errors.ts';
import { McpInputSuspension } from './suspension.ts';
import type { McpCheckpoint } from './suspension.ts';
import { sanitizeServerText, capText } from './text.ts';
import { pause } from './timers.ts';
import type { McpTimers } from './timers.ts';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_TASK_POLL_MS = 1000;
export const MIN_TASK_POLL_MS = 250;
const MAX_TASK_MESSAGE_CHARS = 500;

export type TaskMethod = 'tasks/get' | 'tasks/update' | 'tasks/cancel';

export type TaskParams = { taskId: string; inputResponses?: Record<string, ElicitationAnswer> };

export type TaskRequester = (method: TaskMethod, params: TaskParams, signal: AbortSignal | undefined) => Promise<unknown>;

type TaskBase = { taskId: string; pollIntervalMs: number | undefined; serverAgeMs: number | undefined; ttlMs: number | undefined };

type TaskView =
  | (TaskBase & { status: 'working' })
  | (TaskBase & { status: 'input_required'; inputRequests: unknown })
  | (TaskBase & { status: 'completed'; result: unknown })
  | (TaskBase & { status: 'failed'; error: unknown })
  | (TaskBase & { status: 'cancelled'; message: string | undefined });

export const parseTask = (value: unknown): TaskView => {
  if (!isRecord(value) || typeof value['taskId'] !== 'string') throw new McpTaskError('', 'the server returned a task without a taskId');
  const taskId = value['taskId'];
  const poll = value['pollIntervalMs'];
  const pollIntervalMs = typeof poll === 'number' && Number.isFinite(poll) ? poll : undefined;
  const ttl = value['ttlMs'];
  const ttlMs = typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0 ? ttl : undefined;
  const createdAt = typeof value['createdAt'] === 'string' ? Date.parse(value['createdAt']) : Number.NaN;
  const lastUpdatedAt = typeof value['lastUpdatedAt'] === 'string' ? Date.parse(value['lastUpdatedAt']) : Number.NaN;
  const serverAgeMs = Number.isNaN(createdAt) || Number.isNaN(lastUpdatedAt) || lastUpdatedAt < createdAt ? undefined : lastUpdatedAt - createdAt;
  const base: TaskBase = { taskId, pollIntervalMs, ttlMs, serverAgeMs };
  const status = value['status'];
  if (status === 'working') return { ...base, status };
  if (status === 'input_required') return { ...base, status, inputRequests: value['inputRequests'] };
  if (status === 'completed') return { ...base, status, result: value['result'] };
  if (status === 'failed') return { ...base, status, error: value['error'] };
  if (status === 'cancelled') {
    const message = value['statusMessage'];
    return { ...base, status, message: typeof message === 'string' ? message : undefined };
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
  clock: Clock;
  signal: AbortSignal;
  onCheckpoint(checkpoint: McpCheckpoint): void;
  accept(taskId: string, result: unknown): CallToolResult;
  trackCancel(outcome: Promise<void>): void;
};

export const settleTask = async ({ start, answers, request, timers, clock, signal, onCheckpoint, accept, trackCancel }: SettleTaskOptions): Promise<CallToolResult> => {
  const answered = new Set<string>('answered' in start ? start.answered : []);
  const checkpoint = (taskId: string): McpCheckpoint => ({ kind: 'task', taskId, answered: [...answered] });
  const cancelThenFail = async (taskId: string, failure: McpTaskError | McpInputProtocolError): Promise<never> => {
    try {
      await request('tasks/cancel', { taskId }, signal);
    } catch (cancelError) {
      failure.cancelFailure = cancelError;
    }
    throw failure;
  };
  const cancelThenAbort = (taskId: string): never => {
    trackCancel(request('tasks/cancel', { taskId }, undefined).then(() => undefined));
    throw signal.reason;
  };
  let ageOffsetMs = Number.NEGATIVE_INFINITY;
  const receive = (raw: unknown): { view: TaskView; ageMs: number } => {
    const view = parseTask(raw);
    const now = clock.now();
    ageOffsetMs = Math.max(ageOffsetMs, (view.serverAgeMs ?? 0) - now);
    return { view, ageMs: now + ageOffsetMs };
  };
  let received: { view: TaskView; ageMs: number };
  if ('created' in start) {
    received = receive(start.created);
    onCheckpoint(checkpoint(received.view.taskId));
  } else {
    received = receive(await request('tasks/get', { taskId: start.taskId }, signal));
  }
  const { taskId } = received.view;
  for (;;) {
    const { view, ageMs } = received;
    if ((view.status === 'working' || view.status === 'input_required') && view.ttlMs !== undefined && ageMs > view.ttlMs) {
      return cancelThenFail(taskId, new McpTaskError(taskId, `task ${taskId} was still ${view.status} when its ttl of ${view.ttlMs}ms ran out`));
    }
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
          return cancelThenFail(taskId, error instanceof McpInputProtocolError ? error : new McpTaskError(taskId, `task ${taskId} carried input requests that could not be read`, { cause: error }));
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
    if (signal.aborted) return cancelThenAbort(taskId);
    try {
      received = receive(await request('tasks/get', { taskId }, signal));
    } catch (error) {
      if (!signal.aborted) throw error;
      return cancelThenAbort(taskId);
    }
  }
};
