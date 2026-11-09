import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { STORE_MAX_TOTAL_ATTEMPTS } from '../../src/process/constants.ts';
import type { FakeScriptedReply } from '@momonga/testkit';
import { approveOnce, launchRuntime, readDb, runStatus, scriptedToolCall, startStack, waitForCondition, waitForStatus } from './run-helpers.ts';
import type { Launched, RunHome, Stack } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

const MAX_STEPS_INSTRUCTION =
  'You have reached the max_steps limit. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools.';

const SUMMARY_REPLY: FakeScriptedReply = {
  kind: 'stream',
  chunks: [{ delta: { role: 'assistant', content: 'Summary of the work.' }, finishReason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
};

const REJECTION: FakeScriptedReply = {
  kind: 'error',
  status: 400,
  body: { error: { message: 'the prompt is longer than the model accepts', type: 'invalid_request_error', code: 'context_length_exceeded' } },
};

const START_MS = Date.now();

const BROKEN_STREAM: FakeScriptedReply = { kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'partial' } }], done: false };

const EXPECTED_DEAD_LETTER = (runId: string) => ({ code: 'max_total_attempts', message: `run ${runId} exceeded ${STORE_MAX_TOTAL_ATTEMPTS} total attempts` });

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'];

const advanceUntil = async (
  temp: RunHome,
  runId: string,
  clock: ReturnType<typeof createFakeClock>,
  timers: ReturnType<typeof createFakeTimers>,
): Promise<string> => {
  for (let round = 0; round < 4000; round += 1) {
    const status = runStatus(temp, runId);
    if (status !== undefined && TERMINAL.includes(status)) return status;
    if (status === 'WAITING_HUMAN') throw new Error(`run ${runId} asked for approval`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const next = [...timers.pending()].sort((left, right) => left.dueAt - right.dueAt)[0];
    if (next !== undefined && status === 'QUEUED') timers.advance(Math.max(0, next.dueAt - clock.now()));
  }
  throw new Error(`run ${runId} did not reach a terminal state`);
};

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown };

const completionBodies = (stack: Stack): Record<string, unknown>[] =>
  stack.fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => request.body as Record<string, unknown>);

const settle = async (launched: Launched, temp: RunHome, runId: string): Promise<string> => {
  for (let round = 0; round < 10; round += 1) {
    const status = await waitForStatus(temp, runId, ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED', 'WAITING_HUMAN']);
    if (status !== 'WAITING_HUMAN') return status;
    await approveOnce(launched, runId);
    await waitForCondition(() => runStatus(temp, runId) !== 'WAITING_HUMAN', `run ${runId} to leave WAITING_HUMAN`);
  }
  throw new Error(`run ${runId} kept asking for approval`);
};

const noticesOf = (temp: RunHome, runId: string): string[] =>
  readDb<{ payload_json: string }>(temp.paths.databases.runtime, "SELECT payload_json FROM events WHERE run_id = ? AND type = 'notice' ORDER BY seq", runId).map(
    (row) => (JSON.parse(row.payload_json) as { message: string }).message,
  );

const startWrapUpRun = async (second: FakeScriptedReply, options: { repeat?: number; launch?: Parameters<typeof launchRuntime>[1] } = {}) => {
  const replies = Array.from({ length: options.repeat ?? 1 }, () => second);
  const stack = await startStack((temp) => ({ script: [scriptedToolCall('Read', { file_path: path.join(temp.project, 'notes.txt') }), ...replies] }));
  fs.writeFileSync(path.join(stack.temp.project, 'notes.txt'), 'remember this\n');
  const launched = await launchRuntime(stack.temp, options.launch);
  const session = await launched.createSession();
  const run = await launched.createRun(session.id, { input: 'Read the notes', limits: { maxSteps: 1 } });
  return { stack, launched, runId: run.id as string };
};

describe('wrap-up call on the wire (in-process gateway, fake chat-completions upstream)', () => {
  it('sends the max_steps wrap-up without tools, with plain-text tool history and the instruction last in the final user message', PROCESS_TIMEOUT, async () => {
    const { stack, launched, runId } = await startWrapUpRun(SUMMARY_REPLY);

    expect(await settle(launched, stack.temp, runId)).toBe('STOPPED');
    const view = (await launched.http('GET', `/v1/runs/${runId}`)).json.run;
    expect(view.stopReason).toBe('max_steps');

    const bodies = completionBodies(stack);
    expect(bodies).toHaveLength(2);
    const wrapUp = bodies[1] as Record<string, unknown>;
    expect(wrapUp['tools'] ?? []).toEqual([]);
    const messages = wrapUp['messages'] as ChatMessage[];
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
    expect(messages.some((message) => message.tool_calls !== undefined)).toBe(false);
    expect(messages.some((message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('"kind":"tool_calls"'))).toBe(true);
    const last = messages.at(-1);
    expect(last?.role).toBe('user');
    expect(typeof last?.content).toBe('string');
    expect(last?.content as string).toContain('<tool_result call_id="');
    expect((last?.content as string).endsWith(`</tool_result>\n\n${MAX_STEPS_INSTRUCTION}`)).toBe(true);
  });

  it('stops with max_steps and a notice when the upstream answers HTTP 400 to the wrap-up call, without requeueing', PROCESS_TIMEOUT, async () => {
    const { stack, launched, runId } = await startWrapUpRun(REJECTION);

    const status = await settle(launched, stack.temp, runId);
    const view = (await launched.http('GET', `/v1/runs/${runId}`)).json.run;
    expect({ status, stopReason: view.stopReason, error: view.error }).toEqual({ status: 'STOPPED', stopReason: 'max_steps', error: undefined });
    expect(noticesOf(stack.temp, runId).some((message) => message.includes('context_window_exceeded'))).toBe(true);
    expect(stack.completions()).toBe(2);
  });

  it('dead-letters a run whose wrap-up stream fails after it opened at the total attempt limit before the deadline, with at most one wrap-up POST per attempt', PROCESS_TIMEOUT, async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const { stack, launched, runId } = await startWrapUpRun(BROKEN_STREAM, { repeat: 40, launch: { clock, fakeTimers: timers } });

    const terminal = await advanceUntil(stack.temp, runId, clock, timers);

    const view = (await launched.http('GET', `/v1/runs/${runId}`)).json.run;
    expect(terminal).toBe('FAILED');
    expect(view.error.code).toBe(EXPECTED_DEAD_LETTER(runId).code);
    expect(view.error.message).toContain(`run ${runId} exceeded ${STORE_MAX_TOTAL_ATTEMPTS} total attempts; the last attempt failed with: `);
    expect(clock.now() - START_MS).toBeLessThan(view.deadlineAt - START_MS);
    expect(stack.completions()).toBeGreaterThanOrEqual(2);
    expect(stack.completions()).toBeLessThanOrEqual(1 + STORE_MAX_TOTAL_ATTEMPTS);
    const restarts = readDb<{ n: number }>(stack.temp.paths.databases.runtime, "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'run.started'", runId)[0]?.n;
    expect(restarts).toBe(STORE_MAX_TOTAL_ATTEMPTS);
  });
});
