import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import type { RunEventFrame, RuntimeClient } from './support/runtime-client.ts';
import { DEFAULT_E2E_DEPS, startStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { chatCompletions, hangReply, messagesOf, precedingAssistantCallId, textReply, toolCallReply } from './support/upstream.ts';
import type { ChatMessage } from './support/upstream.ts';
import {
  E2E_CANCEL_STREAM_BOUND_MS,
  E2E_MARGIN_MS,
  E2E_RECOVERY_BOUND_MS,
  E2E_RESTART_BOUND_MS,
  E2E_RESTART_POLICY,
  E2E_RUN_COMPLETED_BOUND_MS,
  E2E_TEST_TIMEOUT_MS,
  until,
} from './support/wait.ts';

const INTERRUPTED_MARKER = '[The user interrupted the previous request before it was finished.]';
const PLAN_ARGS = { entries: [{ content: 'inspect the code', status: 'in_progress', priority: 'high' }] };

type EventRow = { seq: number; type: string; payload_json: string };

const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '')).join('');
};

const turnsOf = (messages: readonly ChatMessage[]): [string, string][] => messages.map((message) => [message.role, contentText(message.content)]);

const conversationOf = (messages: readonly ChatMessage[]): [string, string][] => turnsOf(messages.filter((message) => message.role !== 'system'));

const untilStatus = async (runtime: RuntimeClient, runId: string, status: string, deadlineMs = E2E_RUN_COMPLETED_BOUND_MS): Promise<void> => {
  await until(async () => (await runtime.getRun(runId)).run.status === status, { deadlineMs, description: `run ${runId} is ${status}` });
};

const framesOf = async (runtime: RuntimeClient, runId: string): Promise<RunEventFrame[]> => {
  const stream = runtime.events(runId);
  const frames = await stream.toEnd(E2E_MARGIN_MS);
  await stream.close();
  return frames;
};

const eventRows = (home: E2eHome, runId: string, types: readonly string[]): EventRow[] =>
  readDb<EventRow>(
    home.paths.databases.runtime,
    `SELECT seq, type, payload_json FROM events WHERE run_id = ? AND type IN (${types.map(() => '?').join(', ')}) ORDER BY seq`,
    runId,
    ...types,
  );

const runRowOf = (home: E2eHome, runId: string) =>
  readDb<{ status: string; lease_owner: string | null }>(home.paths.databases.runtime, 'SELECT status, lease_owner FROM runs WHERE id = ?', runId)[0];

describe('multi-turn sessions', () => {
  it(titleOf('mt1'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, script: [textReply('first'), textReply('second'), textReply('third'), textReply('fourth')] });
    const runtime = createRuntimeClient(home);
    const hold = { current: undefined as ReturnType<typeof stack.fake.hold> | undefined };
    try {
      const { session } = await runtime.createSession();
      const first = (await runtime.createRun(session.id, 'Say hello')).run;
      await untilStatus(runtime, first.id, 'COMPLETED');
      const second = (await runtime.createRun(session.id, 'And again')).run;
      await untilStatus(runtime, second.id, 'COMPLETED');

      const requests = chatCompletions(stack.fake);
      expect(requests).toHaveLength(2);
      const messages = messagesOf(requests[1]);
      expect(messages[0]?.role).toBe('system');
      expect(conversationOf(messages)).toEqual([
        ['user', 'Say hello'],
        ['assistant', 'first'],
        ['user', 'And again'],
      ]);
      expect((await runtime.getRun(second.id)).run).toMatchObject({ previousRunId: first.id, history: 'inherit' });

      const frames = await framesOf(runtime, second.id);
      const types = frames.map((frame) => frame.data.type);
      expect(types[0]).toBe('user.message');
      expect(types[1]).toBe('context.inherited');
      expect(types.indexOf('context.inherited')).toBeLessThan(types.indexOf('run.started'));
      const [inherited] = framesOfType(frames, 'context.inherited');
      expect(inherited?.data.seq).toBe(2);
      expect(inherited?.data).not.toHaveProperty('history');
      expect(inherited?.data).not.toHaveProperty('summary');
      expect(inherited?.data).toMatchObject({ fromRunId: first.id, itemCount: 2, nextItemSeq: 3, closures: [], markers: [], partialMessage: false });

      const other = (await runtime.createSession()).session;
      hold.current = stack.fake.hold();
      const runA = (await runtime.createRun(other.id, 'Count to one')).run;
      const runB = (await runtime.createRun(other.id, 'Count to two')).run;
      await hold.current.waitForRequest();
      expect((await runtime.getRun(runB.id)).run.status).toBe('QUEUED');
      hold.current.release();
      await untilStatus(runtime, runA.id, 'COMPLETED');
      await untilStatus(runtime, runB.id, 'COMPLETED');
      expect(conversationOf(messagesOf(chatCompletions(stack.fake)[3]))).toEqual([
        ['user', 'Count to one'],
        ['assistant', 'third'],
        ['user', 'Count to two'],
      ]);
    } finally {
      hold.current?.release();
      await runtime.close();
    }
  });

  it(titleOf('mt1b'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({
      home,
      script: [toolCallReply('UpdatePlan', PLAN_ARGS, 'call_1'), textReply('planned one'), toolCallReply('UpdatePlan', PLAN_ARGS, 'call_1'), textReply('planned two')],
    });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const first = (await runtime.createRun(session.id, 'Plan once')).run;
      await untilStatus(runtime, first.id, 'COMPLETED');
      const second = (await runtime.createRun(session.id, 'Plan again')).run;
      await untilStatus(runtime, second.id, 'COMPLETED');

      expect(framesOfType(await framesOf(runtime, first.id), 'tool.completed')).toHaveLength(1);
      expect(framesOfType(await framesOf(runtime, second.id), 'tool.completed')).toHaveLength(1);
      const requests = chatCompletions(stack.fake);
      expect(requests).toHaveLength(4);
      const messages = messagesOf(requests[3]);
      const tools = messages.filter((message) => message.role === 'tool');
      expect(tools).toHaveLength(2);
      const ids = tools.map((tool) => precedingAssistantCallId(messages, tool));
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids).not.toContain('call_1');
      expect(tools.map((tool) => tool.tool_call_id)).toEqual(ids);
    } finally {
      await runtime.close();
    }
  });

  const killDuringInheritedCall = async (release: 'after-claim' | 'while-down'): Promise<void> => {
    const home = await createE2eHome();
    const stack = await startStack({ home, deps: { ...DEFAULT_E2E_DEPS, restart: E2E_RESTART_POLICY }, script: [textReply('first'), textReply('second')] });
    const runtime = createRuntimeClient(home);
    let hold: ReturnType<typeof stack.fake.hold> | undefined;
    let released = false;
    const releaseOnce = (): void => {
      if (released || hold === undefined) return;
      released = true;
      hold.release();
    };
    try {
      const { session } = await runtime.createSession();
      const first = (await runtime.createRun(session.id, 'Say hello')).run;
      await untilStatus(runtime, first.id, 'COMPLETED');
      hold = stack.fake.hold();
      const second = (await runtime.createRun(session.id, 'And again')).run;
      await hold.waitForRequest();
      const before = await until(
        () => {
          const rows = eventRows(home, second.id, ['context.inherited', 'model.requested']);
          return rows.some((row) => row.type === 'model.requested') ? rows : undefined;
        },
        { deadlineMs: E2E_MARGIN_MS, description: `run ${second.id} model.requested readable` },
      );
      expect(before.map((row) => row.type)).toEqual(['context.inherited', 'model.requested']);

      const health = await stack.client.health();
      const oldRuntimePid = childOf(health, 'runtime').pid;
      const oldGateway = childOf(health, 'gateway');
      if (oldRuntimePid === undefined) throw new Error('runtime has no pid');
      process.kill(oldRuntimePid, 'SIGKILL');
      if (release === 'while-down') releaseOnce();

      const restarted = await stack.client.untilChild(
        'runtime',
        (child) => child.state === 'ready' && child.pid !== undefined && child.pid !== oldRuntimePid && child.restarts === 1,
        E2E_RESTART_BOUND_MS,
      );
      await until(
        () => {
          const row = runRowOf(home, second.id);
          if (row === undefined) return false;
          const claimed = row.status === 'RUNNING' && row.lease_owner !== null && row.lease_owner.startsWith(`runtime-${String(restarted.pid)}-`);
          return claimed || (release === 'while-down' && row.status === 'COMPLETED');
        },
        { deadlineMs: E2E_RECOVERY_BOUND_MS, description: `run ${second.id} claimed by the restarted runtime` },
      );
      releaseOnce();
      await untilStatus(runtime, second.id, 'COMPLETED');

      const requests = chatCompletions(stack.fake);
      expect(requests).toHaveLength(2);
      expect(conversationOf(messagesOf(requests[1]))).toEqual([
        ['user', 'Say hello'],
        ['assistant', 'first'],
        ['user', 'And again'],
      ]);
      const frames = await framesOf(runtime, second.id);
      expect(framesOfType(frames, 'context.inherited')).toHaveLength(1);
      expect(framesOfType(frames, 'model.requested')).toHaveLength(1);
      const after = eventRows(home, second.id, ['context.inherited', 'model.requested']);
      expect(after).toEqual(before);
      const requested = JSON.parse(after[1]!.payload_json) as { digest: string; body: unknown };
      expect(requested.digest).toBe(sha256Hex(canonicalJson(requested.body)));
      const gatewayAfter = childOf(await stack.client.health(), 'gateway');
      expect(gatewayAfter.pid).toBe(oldGateway.pid);
      expect(gatewayAfter.restarts).toBe(0);
    } finally {
      releaseOnce();
      await runtime.close();
    }
  };

  it(titleOf('mt2-join'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    await killDuringInheritedCall('after-claim');
  });

  it(titleOf('mt2-replay'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    await killDuringInheritedCall('while-down');
  });

  it(titleOf('mt3'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, script: [hangReply('partial words'), textReply('second')] });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const first = (await runtime.createRun(session.id, 'Say hello')).run;
      const stream = runtime.events(first.id);
      await stream.until((frame) => frame.data.type === 'agent.message.delta', E2E_RECOVERY_BOUND_MS);
      await runtime.cancel(first.id);
      await untilStatus(runtime, first.id, 'CANCELLED', E2E_CANCEL_STREAM_BOUND_MS);
      const firstFrames = await stream.toEnd(E2E_MARGIN_MS);
      await stream.close();
      const streamed = framesOfType(firstFrames, 'agent.message.delta').map((frame) => String(frame.data.text)).join('');
      expect(streamed).toBe('partial words');

      const second = (await runtime.createRun(session.id, 'And again')).run;
      await untilStatus(runtime, second.id, 'COMPLETED');

      const requests = chatCompletions(stack.fake);
      expect(requests).toHaveLength(2);
      const messages = messagesOf(requests[1]);
      expect(turnsOf(messages).slice(1)).toEqual([
        ['user', 'Say hello'],
        ['assistant', 'partial words'],
        ['user', `${INTERRUPTED_MARKER}\n\nAnd again`],
      ]);
      expect(messages.some((message, index) => index > 0 && message.role === 'user' && messages[index - 1]?.role === 'user')).toBe(false);
      const [row] = eventRows(home, second.id, ['context.inherited']);
      const inherited = JSON.parse(row!.payload_json) as { history: { item: { role?: string; status?: string; content?: unknown } }[]; partial?: { seq: number } };
      const partial = inherited.history.find((entry) => entry.item.role === 'assistant');
      expect(partial?.item.status).toBe('incomplete');
      expect(contentText(partial?.item.content)).toBe(streamed);
      expect(inherited.partial).toEqual({ seq: 2 });
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('mt4'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, script: [textReply('one'), textReply('two'), textReply('three'), textReply('four')] });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      for (const input of ['First', 'Second']) {
        const run = (await runtime.createRun(session.id, input)).run;
        await untilStatus(runtime, run.id, 'COMPLETED');
      }
      const third = (await runtime.createRun(session.id, 'Third', { history: 'fresh' })).run;
      await untilStatus(runtime, third.id, 'COMPLETED');
      expect((await runtime.getRun(third.id)).run).toMatchObject({ history: 'fresh' });
      const fourth = (await runtime.createRun(session.id, 'Fourth')).run;
      await untilStatus(runtime, fourth.id, 'COMPLETED');

      const requests = chatCompletions(stack.fake);
      expect(requests).toHaveLength(4);
      expect(conversationOf(messagesOf(requests[2]))).toEqual([['user', 'Third']]);
      expect(conversationOf(messagesOf(requests[3]))).toEqual([
        ['user', 'Third'],
        ['assistant', 'three'],
        ['user', 'Fourth'],
      ]);
    } finally {
      await runtime.close();
    }
  });
});
