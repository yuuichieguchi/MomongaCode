import { describe, expect, it } from 'vitest';
import { startMcpHttpFixture, startMcpOauthFixture } from '@momonga/testkit';
import type { McpHttpFixture } from '@momonga/testkit';
import { skipCase, titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { startStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { chatCompletions, messagesOf, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_CANCEL_SWEEP_BOUND_MS, E2E_MCP_AUTHORIZATION_BOUND_MS, E2E_RECOVERY_BOUND_MS, E2E_RESTART_BOUND_MS, E2E_RESTART_POLICY, E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const bodyOf = (response: { status: number; body: unknown }, status: number): Record<string, unknown> => {
  if (response.status !== status || !isRecord(response.body)) throw new Error(`expected ${status}, got ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
};

const toolMessages = (stack: Awaited<ReturnType<typeof startStack>>): string[] =>
  messagesOf(chatCompletions(stack.fake).at(-1))
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.stringify(message.content));

const startRemote = async (fixture: McpHttpFixture, script: ReturnType<typeof textReply>[]) => {
  const home = await createE2eHome();
  const stack = await startStack({
    home,
    deps: { restart: E2E_RESTART_POLICY },
    settings: { mcpServers: { remote: { type: 'http', url: fixture.url } } },
    script,
  });
  return { home, stack };
};

const elicitationOf = async (runtime: RuntimeClient, runId: string): Promise<Record<string, unknown>> => {
  const listed = await until(
    async () => {
      const body = bodyOf(await runtime.json('GET', `/v1/runs/${runId}/elicitations`), 200);
      const found = body['elicitations'];
      return Array.isArray(found) && found.length > 0 ? found : undefined;
    },
    { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `an elicitation of run ${runId}` },
  );
  const [first] = listed as unknown[];
  if (!isRecord(first)) throw new Error('malformed elicitation');
  return first;
};

const untilCancelled = async (runtime: RuntimeClient, runId: string): Promise<void> => {
  const stream = runtime.events(runId);
  try {
    await stream.until((frame) => frame.data.type === 'run.status' && frame.data.to === 'CANCELLED', E2E_CANCEL_SWEEP_BOUND_MS);
  } finally {
    await stream.close();
  }
};

describe('mcp: client gaps', () => {
  it.skipIf(skipCase('mcp-oauth-login'))(titleOf('mcp-oauth-login'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const oauth = await startMcpOauthFixture();
    const fixture = await startMcpHttpFixture({ era: 'modern', oauth });
    const { home, stack } = await startRemote(fixture, [
      toolCallReply('mcp__remote__echo', { text: 'first' }, 'call_1'),
      textReply('needs login'),
      toolCallReply('mcp__remote__echo', { text: 'after login' }, 'call_2'),
      textReply('done'),
    ]);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const first = await runtime.createRun(session.id, 'Use the remote tool');
      const stream = runtime.events(first.run.id);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      const required = framesOfType(frames, 'mcp.authorization.required');
      expect(required).toHaveLength(1);
      expect(required[0]?.data).toMatchObject({ server: 'remote' });
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');

      const listed = bodyOf(await runtime.json('GET', `/v1/sessions/${session.id}/mcp/servers`), 200);
      expect(listed['servers']).toMatchObject([{ name: 'remote', transport: 'http', auth: 'required' }]);

      const started = bodyOf(await runtime.json('POST', `/v1/sessions/${session.id}/mcp/servers/remote/authorization`), 202);
      const authorization = started['authorization'];
      if (!isRecord(authorization) || typeof authorization['url'] !== 'string') throw new Error(`no authorization url: ${JSON.stringify(started)}`);
      expect(authorization['status']).toBe('awaiting_user');

      const authorize = await fetch(authorization['url'], { redirect: 'manual' });
      const location = authorize.headers.get('location');
      if (location === null) throw new Error(`the authorization endpoint did not redirect (${authorize.status})`);
      await (await fetch(location)).arrayBuffer();

      await until(
        async () => {
          const view = bodyOf(await runtime.json('GET', `/v1/sessions/${session.id}/mcp/servers/remote/authorization`), 200)['authorization'];
          return isRecord(view) && view['status'] === 'completed';
        },
        { deadlineMs: E2E_MCP_AUTHORIZATION_BOUND_MS, description: 'the authorization to complete' },
      );
      expect(bodyOf(await runtime.json('GET', `/v1/sessions/${session.id}/mcp/servers`), 200)['servers']).toMatchObject([{ auth: 'authorized' }]);

      const second = await runtime.createRun(session.id, 'Use the remote tool again');
      const secondStream = runtime.events(second.run.id);
      const secondFrames = await secondStream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await secondStream.close();
      expect(secondFrames.at(-1)?.data.to).toBe('COMPLETED');
      expect(framesOfType(secondFrames, 'mcp.authorization.required')).toHaveLength(0);
      expect(toolMessages(stack).some((message) => message.includes('after login'))).toBe(true);
    } finally {
      await runtime.close();
      await fixture.close();
      await oauth.close();
    }
  });

  it.skipIf(skipCase('mcp-elicitation'))(titleOf('mcp-elicitation'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const fixture = await startMcpHttpFixture({ era: 'modern' });
    const { home, stack } = await startRemote(fixture, [toolCallReply('mcp__remote__mrtr_elicit', {}, 'call_1'), textReply('done')]);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Ask me who I am');
      const stream = runtime.events(run.id);
      const elicitation = await elicitationOf(runtime, run.id);
      expect(elicitation).toMatchObject({ server: 'remote', status: 'pending', requests: [{ key: 'who', mode: 'form', message: 'Who are you?' }] });
      expect((await runtime.getRun(run.id)).run.status).toBe('WAITING_HUMAN');
      expect(fixture.rpcRecords('tools/call')).toHaveLength(1);

      const refused = await runtime.json('POST', `/v1/elicitations/${String(elicitation['id'])}`, { responses: { who: { action: 'accept', content: { name: 7 } } } });
      expect(refused.status).toBe(400);
      expect(fixture.rpcRecords('tools/call')).toHaveLength(1);

      const answered = await runtime.json('POST', `/v1/elicitations/${String(elicitation['id'])}`, { responses: { who: { action: 'accept', content: { name: 'Ada' } } } });
      expect(answered.status).toBe(200);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');
      expect(framesOfType(frames, 'tool.elicitation.requested')).toHaveLength(1);
      expect(framesOfType(frames, 'tool.elicitation.resolved')).toHaveLength(1);
      expect(toolMessages(stack).some((message) => message.includes('hello Ada'))).toBe(true);

      const calls = fixture.rpcRecords('tools/call');
      expect(calls).toHaveLength(2);
      expect(calls[1]?.rpc?.params['requestState']).toBe('ask');
      expect(calls[1]?.rpc?.params['inputResponses']).toEqual({ who: { action: 'accept', content: { name: 'Ada' } } });
    } finally {
      await runtime.close();
      await fixture.close();
    }
  });

  it.skipIf(skipCase('mcp-task-input'))(titleOf('mcp-task-input'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const fixture = await startMcpHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const { home, stack } = await startRemote(fixture, [toolCallReply('mcp__remote__ask_task', {}, 'call_1'), textReply('done')]);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Run the task that asks me');
      const stream = runtime.events(run.id);
      const elicitation = await elicitationOf(runtime, run.id);
      expect(elicitation).toMatchObject({ server: 'remote', requests: [{ key: 'name', mode: 'form' }] });
      expect(fixture.rpcRecords('tasks/update')).toHaveLength(0);

      bodyOf(await runtime.json('POST', `/v1/elicitations/${String(elicitation['id'])}`, { responses: { name: { action: 'accept', content: { name: 'Grace' } } } }), 200);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');
      expect(toolMessages(stack).some((message) => message.includes('hello Grace'))).toBe(true);
      expect(fixture.rpcRecords('tools/call')).toHaveLength(1);
      expect(fixture.rpcRecords('tasks/update')).toHaveLength(1);
    } finally {
      await runtime.close();
      await fixture.close();
    }
  });

  it.skipIf(skipCase('mcp-task-input-cancel-after-crash'))(titleOf('mcp-task-input-cancel-after-crash'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const fixture = await startMcpHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const { home, stack } = await startRemote(fixture, [toolCallReply('mcp__remote__ask_task', {}, 'call_1'), textReply('done')]);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Run the task that asks me');
      await elicitationOf(runtime, run.id);
      expect(fixture.rpcRecords('tasks/cancel')).toHaveLength(0);

      const before = childOf(await stack.client.health(), 'runtime');
      if (before.pid === undefined) throw new Error('runtime has no pid');
      process.kill(before.pid, 'SIGKILL');
      await stack.client.untilChild('runtime', (child) => child.state === 'ready' && child.pid !== before.pid && child.restarts === 1, E2E_RESTART_BOUND_MS);

      expect((await runtime.cancel(run.id)).run.status).toBe('CANCELLING');
      await untilCancelled(runtime, run.id);
      await until(() => fixture.rpcRecords('tasks/cancel').length === 1, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the restarted runtime to cancel the parked task' });
      await until(
        () => readDb<{ state: string }>(home.paths.databases.runtime, 'SELECT state FROM idempotency').every((row) => row.state !== 'PENDING'),
        { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the idempotency record of the parked call to leave PENDING' },
      );
    } finally {
      await runtime.close();
      await fixture.close();
    }
  });

  it.skipIf(skipCase('mcp-cancel-release-after-crash'))(titleOf('mcp-cancel-release-after-crash'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const fixture = await startMcpHttpFixture({ era: 'modern', taskPollIntervalMs: 1, holdFirstTaskCancel: true });
    const { home, stack } = await startRemote(fixture, [toolCallReply('mcp__remote__ask_task', {}, 'call_1'), textReply('done')]);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Run the task that asks me');
      await elicitationOf(runtime, run.id);

      expect((await runtime.cancel(run.id)).run.status).toBe('CANCELLING');
      await untilCancelled(runtime, run.id);
      await fixture.until(() => fixture.notes.some((note) => note.type === 'task_cancel_held'));
      expect(fixture.notes.some((note) => note.type === 'task_cancel')).toBe(false);
      expect(readDb<{ state: string }>(home.paths.databases.runtime, 'SELECT state FROM idempotency').some((row) => row.state === 'PENDING')).toBe(true);

      const before = childOf(await stack.client.health(), 'runtime');
      if (before.pid === undefined) throw new Error('runtime has no pid');
      process.kill(before.pid, 'SIGKILL');
      await stack.client.untilChild('runtime', (child) => child.state === 'ready' && child.pid !== before.pid && child.restarts === 1, E2E_RESTART_BOUND_MS);

      await until(() => fixture.notes.some((note) => note.type === 'task_cancel'), { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the restarted runtime to release the parked task of the cancelled run' });
      await until(
        () => readDb<{ state: string }>(home.paths.databases.runtime, 'SELECT state FROM idempotency').every((row) => row.state !== 'PENDING'),
        { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the idempotency record of the parked call to leave PENDING' },
      );
      expect((await runtime.getRun(run.id)).run.status).toBe('CANCELLED');
    } finally {
      await runtime.close();
      await fixture.close();
    }
  });

  it.skipIf(skipCase('mcp-task-recovery'))(titleOf('mcp-task-recovery'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const fixture = await startMcpHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
    const { home, stack } = await startRemote(fixture, [toolCallReply('mcp__remote__long_task', {}, 'call_1'), textReply('done')]);
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Start the long task');
      const taskId = await until(() => fixture.taskIds()[0], { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the server to create a task' });
      await until(
        () =>
          readDb<{ meta_json: string }>(home.paths.databases.runtime, 'SELECT meta_json FROM idempotency WHERE state = ?', 'PENDING').some((row) => row.meta_json.includes(taskId)),
        { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the task id to be recorded' },
      );

      const before = childOf(await stack.client.health(), 'runtime');
      if (before.pid === undefined) throw new Error('runtime has no pid');
      process.kill(before.pid, 'SIGKILL');
      await stack.client.untilChild('runtime', (child) => child.state === 'ready' && child.pid !== before.pid && child.restarts === 1, E2E_RESTART_BOUND_MS);

      const pollsBefore = fixture.rpcRecords('tasks/get').length;
      await until(() => fixture.rpcRecords('tasks/get').length > pollsBefore, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the restarted runtime to poll the recorded task' });
      expect(fixture.rpcRecords('tasks/get').at(-1)?.headers['mcp-name']).toBe(taskId);

      fixture.completeTask(taskId, 'task finished after the crash');
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      expect(frames.at(-1)?.data.to).toBe('COMPLETED');
      expect(toolMessages(stack).some((message) => message.includes('task finished after the crash'))).toBe(true);
      expect(fixture.rpcRecords('tools/call')).toHaveLength(1);
      expect(fixture.taskIds()).toEqual([taskId]);
    } finally {
      await runtime.close();
      await fixture.close();
    }
  });
});
