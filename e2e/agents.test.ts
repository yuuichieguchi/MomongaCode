import { PERSON_CAPABILITY_HEADER } from '@momonga/protocol';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import { TOOL_OUTPUT_TAG, fenceUntrusted } from '@momonga/protocol';
import { skipCase, titleOf } from './support/cases.ts';
import { runCli, startCli } from './support/cli.ts';
import { prepareProduct } from './support/product.ts';
import { readDb } from './support/db.ts';
import { createE2eHome, markersOf } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { TOOL_GROUPS_SQL } from './support/ledger.ts';
import { expectEndedAtTerminal, groupRunning } from './support/process.ts';
import { createRuntimeClient, personCapabilityOfHome, framesOfType } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { SANDBOX_ENDS_WITH_RUNTIME, SIGTERM_DEATH, productSandbox, sandboxOrSkip } from './support/sandbox.ts';
import { shutdownBarrier, startStack, writeSettingsFile } from './support/stack.ts';
import { projectAgentDigestOf } from '@momonga/config';
import { childOf } from './support/supervisor-client.ts';
import { chatCompletions, hangReply, messagesOf, textReply, toolCallReply } from './support/upstream.ts';
import {
  E2E_CANCEL_STREAM_BOUND_MS,
  E2E_RECOVERY_BOUND_MS,
  E2E_RESTART_BOUND_MS,
  E2E_RESTART_POLICY,
  E2E_RUN_COMPLETED_BOUND_MS,
  E2E_TEST_TIMEOUT_MS,
  until,
} from './support/wait.ts';
import type { FakeRoute, FakeScriptedReply } from '@momonga/testkit';
import { firstGeneration } from '@momonga/testkit';
import { fenceBoundaryIn } from '@momonga/testkit';

type Json = Record<string, any>;

const rawGet = async (home: E2eHome, target: string): Promise<{ status: number; json: Json }> => {
  const client = createUdsClient(fixedSocket(firstGeneration(home.paths).sockets.runtime), { connectTimeoutMs: 0 });
  try {
    const response = await client.request({ method: 'GET', path: target });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Json) };
  } finally {
    await client.close();
  }
};

const trustProject = async (home: E2eHome): Promise<void> => {
  const client = createUdsClient(fixedSocket(firstGeneration(home.paths).sockets.runtime), { connectTimeoutMs: 0 });
  try {
    const response = await client.request({
      method: 'PUT',
      path: '/v1/trust',
      headers: { 'content-type': 'application/json', [PERSON_CAPABILITY_HEADER]: await personCapabilityOfHome(home) },
      body: JSON.stringify({ path: home.project, decision: 'trusted' }),
    });
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    await client.close();
  }
};

const agentText = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${name} helper\ntools: Read\n---\n${body}\n`;

const writeAgent = (home: E2eHome, name: string, body: string): void => {
  const directory = path.join(home.project, '.momonga', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), agentText(name, body));
};

const approveAgent = (home: E2eHome, name: string, body: string): void => {
  const settings: Json = JSON.parse(fs.readFileSync(home.paths.settingsFile, 'utf8'));
  const text = agentText(name, body);
  writeSettingsFile(home, { ...settings, projectApprovals: { [fs.realpathSync(home.project)]: { agents: [{ name, digest: projectAgentDigestOf(name, text), text }] } } });
};

const agentCall = (callId = 'call_agent'): FakeScriptedReply =>
  toolCallReply('Agent', { description: 'review', prompt: 'Look at the change', subagent_type: 'reviewer' }, callId);

const runRow = (home: E2eHome, runId: string) =>
  readDb<{ status: string; parent_run_id: string | null }>(home.paths.databases.runtime, 'SELECT status, parent_run_id FROM runs WHERE id = ?', runId)[0];

const childRunsOf = (home: E2eHome, parentId: string): { id: string; status: string }[] =>
  readDb<{ id: string; status: string }>(home.paths.databases.runtime, 'SELECT id, status FROM runs WHERE parent_run_id = ? ORDER BY created_at', parentId);

const untilStatus = async (runtime: RuntimeClient, runId: string, status: string, deadlineMs: number): Promise<void> => {
  await until(async () => (await runtime.getRun(runId)).run.status === status, { deadlineMs, description: `run ${runId} is ${status}` });
};

const toolTexts = (request: Parameters<typeof messagesOf>[0]): string[] =>
  messagesOf(request)
    .filter((message) => message.role === 'tool')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));

const agentEnvelopes = (request: Parameters<typeof messagesOf>[0], content: string): string[] =>
  messagesOf(request)
    .filter((message) => message.role === 'tool')
    .map((message) => fenceUntrusted(TOOL_OUTPUT_TAG, { call: String(message.tool_call_id), tool: 'Agent' }, content, fenceBoundaryIn(String(message.content))));

describe('agents: subagents', () => {
  it(titleOf('agent-run'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeAgent(home, 'reviewer', 'You are a terse reviewer.');
    const stack = await startStack({ home, script: [agentCall(), textReply('child verdict: ship it'), textReply('parent done')] });
    await trustProject(home);
    approveAgent(home, 'reviewer', 'You are a terse reviewer.');
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Review my change');
      await untilStatus(runtime, run.id, 'COMPLETED', E2E_RUN_COMPLETED_BOUND_MS);

      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      const statuses = framesOfType(frames, 'run.status').map((frame) => frame.data.to);
      expect(statuses).toEqual(['WAITING_TOOL', 'QUEUED', 'COMPLETED']);
      const [children] = [(await rawGet(home, `/v1/runs/${run.id}/children`)).json['runs'] as Json[]];
      expect(children).toHaveLength(1);
      const child = children[0] as Json;
      expect(child).toMatchObject({ parentRunId: run.id, parentCallId: expect.any(String), agent: 'reviewer', status: 'COMPLETED', history: 'fresh' });
      expect(child['sessionId']).not.toBe(session.id);
      const waiting = framesOfType(frames, 'tool.waiting');
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.data['awaits']).toMatchObject({ kind: 'run', runId: child['id'], agent: 'reviewer' });
      expect(framesOfType(frames, 'tool.completed').map((frame) => frame.data['output'])).toEqual(['child verdict: ship it']);

      const childStream = runtime.events(child['id'] as string);
      const childFrames = await childStream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await childStream.close();
      expect(childFrames[0]?.data).toMatchObject({ type: 'user.message', text: 'Look at the change' });
      expect(childFrames.at(-1)?.data).toMatchObject({ type: 'run.status', to: 'COMPLETED' });

      const sessions = (await rawGet(home, '/v1/sessions')).json['sessions'] as Json[];
      expect(sessions.map((entry) => entry['id'])).toEqual([session.id]);

      const calls = chatCompletions(stack.fake);
      expect(calls).toHaveLength(3);
      const childBody = JSON.stringify(calls[1]?.body);
      expect(childBody).toContain('You are a terse reviewer.');
      expect(childBody).not.toContain('"name":"Agent"');
      expect(JSON.stringify(calls[0]?.body)).toContain('"name":"Agent"');
      expect(toolTexts(calls[2])).toHaveLength(1);
      expect(toolTexts(calls[2])).toEqual(agentEnvelopes(calls[2], 'child verdict: ship it'));
      await shutdownBarrier(stack);
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('agent-cancel'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeAgent(home, 'reviewer', 'You review.');
    const stack = await startStack({ home, script: [agentCall(), hangReply('child partial')] });
    await trustProject(home);
    approveAgent(home, 'reviewer', 'You review.');
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Review my change');
      const child = await until(() => childRunsOf(home, run.id)[0], { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'a child run' });
      await until(() => chatCompletions(stack.fake).length === 2 && stack.fake.openConnections() === 1, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the request of the child reached the upstream and holds its connection' });
      await until(() => runRow(home, run.id)?.status === 'WAITING_TOOL', { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the parent waits' });
      const disconnectsBefore = stack.fake.disconnects();

      expect((await runtime.cancel(run.id)).status).toBe(202);
      await untilStatus(runtime, run.id, 'CANCELLED', E2E_CANCEL_STREAM_BOUND_MS);
      await untilStatus(runtime, child.id, 'CANCELLED', E2E_CANCEL_STREAM_BOUND_MS);
      await until(() => stack.fake.openConnections() === 0 && stack.fake.disconnects() > disconnectsBefore, {
        deadlineMs: E2E_CANCEL_STREAM_BOUND_MS,
        description: 'the child upstream connection was cut',
      });
      const childStream = runtime.events(child.id);
      const childFrames = await childStream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await childStream.close();
      expect(childFrames.at(-1)?.data).toMatchObject({ type: 'run.status', to: 'CANCELLED' });
      expect(framesOfType(childFrames, 'model.responded')).toEqual([]);
      const parentStream = runtime.events(run.id);
      const parentFrames = await parentStream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await parentStream.close();
      expect(framesOfType(parentFrames, 'tool.completed').map((frame) => [frame.data['status'], frame.data['output']])).toEqual([['failed', 'Subagent reviewer was cancelled.']]);
      expect(framesOfType(parentFrames, 'tool.reconciled')).toEqual([]);

      await shutdownBarrier(stack);
      expect(chatCompletions(stack.fake)).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('agent-kill'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    writeAgent(home, 'reviewer', 'You review.');
    const stack = await startStack({
      home,
      deps: { restart: E2E_RESTART_POLICY },
      script: [agentCall(), textReply('child recovered'), textReply('parent done')],
    });
    const parentRequest = stack.fake.hold();
    parentRequest.release();
    const childRequest = stack.fake.hold();
    await trustProject(home);
    approveAgent(home, 'reviewer', 'You review.');
    const runtime = createRuntimeClient(home);
    let released = false;
    const releaseChild = (): void => {
      if (released) return;
      released = true;
      childRequest.release();
    };
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Review my change');
      await childRequest.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the held model request' });
      const child = await until(() => childRunsOf(home, run.id)[0], { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'a child run' });

      const before = await stack.client.health();
      const oldRuntimePid = childOf(before, 'runtime').pid;
      if (oldRuntimePid === undefined) throw new Error('runtime has no pid');
      process.kill(oldRuntimePid, 'SIGKILL');
      await stack.client.untilChild('runtime', (state) => state.state === 'ready' && state.pid !== undefined && state.pid !== oldRuntimePid && state.restarts === 1, E2E_RESTART_BOUND_MS);
      releaseChild();

      await untilStatus(runtime, run.id, 'COMPLETED', E2E_RUN_COMPLETED_BOUND_MS);
      expect(childRunsOf(home, run.id)).toEqual([{ id: child.id, status: 'COMPLETED' }]);
      const calls = chatCompletions(stack.fake);
      expect(calls).toHaveLength(3);
      expect(toolTexts(calls[2])).toHaveLength(1);
      expect(toolTexts(calls[2])).toEqual(agentEnvelopes(calls[2], 'child recovered'));
      const childStream = runtime.events(child.id);
      const childFrames = await childStream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await childStream.close();
      expect(framesOfType(childFrames, 'model.requested')).toHaveLength(1);
      expect(framesOfType(childFrames, 'model.responded')).toHaveLength(1);
      const parentStream = runtime.events(run.id);
      const parentFrames = await parentStream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await parentStream.close();
      expect(framesOfType(parentFrames, 'tool.waiting')).toHaveLength(1);
      expect(framesOfType(parentFrames, 'tool.completed').map((frame) => frame.data['output'])).toEqual(['child recovered']);
    } finally {
      releaseChild();
      await runtime.close();
    }
  });
});

const jobIdOf = (home: E2eHome): string | undefined =>
  readDb<{ id: string }>(home.paths.databases.runtime, 'SELECT id FROM jobs ORDER BY started_at LIMIT 1')[0]?.id;

const jobRow = (home: E2eHome, jobId: string) =>
  readDb<{ status: string; exit_code: number | null; signal: string | null; pgid: number | null }>(
    home.paths.databases.runtime,
    'SELECT status, exit_code, signal, pgid FROM jobs WHERE id = ?',
    jobId,
  )[0];

const toolMessageCount = (body: unknown): number => {
  const messages = typeof body === 'object' && body !== null && 'messages' in body && Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  return messages.filter((message) => message['role'] === 'tool').length;
};

const jobRoutes = (home: E2eHome, second: (jobId: string) => FakeScriptedReply, final: string): FakeRoute[] => jobRoutesIn(() => jobIdOf(home), second, final);

const jobRoutesIn = (jobIdNow: () => string | undefined, second: (jobId: string) => FakeScriptedReply, final: string): FakeRoute[] => {
  const secondReply = toolCallReply('Bash', {}, 'call_second');
  return [
    {
      match: (body) => {
        if (toolMessageCount(body) !== 1) return false;
        const jobId = jobIdNow();
        if (jobId === undefined) return false;
        Object.assign(secondReply, second(jobId));
        return true;
      },
      reply: secondReply,
    },
    { match: (body) => toolMessageCount(body) === 2, reply: textReply(final) },
  ];
};

describe('agents: background bash', () => {
  it.skipIf(skipCase('bg-output'))(titleOf('bg-output'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const stack = await startStack({
      home,
      needsBash: true,
      script: [toolCallReply('Bash', { command: 'echo started; sleep 2; echo ready', run_in_background: true })],
      routes: jobRoutes(home, (jobId) => toolCallReply('BashOutput', { bash_id: jobId, block: true, timeout: 60_000 }, 'call_output'), 'all done'),
    });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Start the build');
      await until(() => runRow(home, run.id)?.status === 'WAITING_TOOL', { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the run waits on the job' });
      const jobId = jobIdOf(home);
      if (jobId === undefined) throw new Error('no job was recorded');
      expect(jobRow(home, jobId)?.status).toBe('running');
      const pgid = jobRow(home, jobId)?.pgid;
      expect(pgid).toBeGreaterThan(1);
      await untilStatus(runtime, run.id, 'COMPLETED', E2E_RUN_COMPLETED_BOUND_MS);

      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      expect(framesOfType(frames, 'tool.waiting').map((frame) => frame.data['awaits'])).toEqual([{ kind: 'job', jobId }]);
      expect(framesOfType(frames, 'job.finished').map((frame) => frame.data)).toMatchObject([{ jobId, status: 'exited', exitCode: 0 }]);
      const outputs = framesOfType(frames, 'tool.completed').map((frame) => String(frame.data['output']));
      expect(outputs[0]).toContain(`Started background job ${jobId}`);
      expect(outputs[1]).toContain(`Job ${jobId}: it exited with code 0.`);
      expect(outputs[1]).toContain('started');
      expect(outputs[1]).toContain('ready');
      expect(jobRow(home, jobId)).toMatchObject({ status: 'exited', exit_code: 0 });
      await expectEndedAtTerminal('exited', { group: pgid as number });
      await until(() => fs.readdirSync(markersOf(home).tools).length === 0, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the marker of the finished job to be removed' });

      const listed = (await rawGet(home, `/v1/sessions/${session.id}/jobs`)).json['jobs'] as Json[];
      expect(listed).toMatchObject([{ id: jobId, status: 'exited', exitCode: 0, command: 'echo started; sleep 2; echo ready' }]);
      expect(chatCompletions(stack.fake)).toHaveLength(3);
      await shutdownBarrier(stack);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('bg-kill'))(titleOf('bg-kill'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const stack = await startStack({
      home,
      needsBash: true,
      script: [toolCallReply('Bash', { command: 'sleep 60', run_in_background: true })],
      routes: jobRoutes(home, (jobId) => toolCallReply('KillBash', { shell_id: jobId }, 'call_kill'), 'stopped it'),
    });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Start the server');
      await untilStatus(runtime, run.id, 'COMPLETED', E2E_RUN_COMPLETED_BOUND_MS);
      const jobId = jobIdOf(home);
      if (jobId === undefined) throw new Error('no job was recorded');
      const job = jobRow(home, jobId);
      const death = SIGTERM_DEATH[productSandbox()];
      expect(job).toMatchObject({ status: 'killed', exit_code: death.exitCode, signal: death.signal });
      await expectEndedAtTerminal('killed', { group: job?.pgid as number });
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      expect(framesOfType(frames, 'job.finished').map((frame) => frame.data)).toMatchObject([{ jobId, status: 'killed' }]);
      const stopped = death.signal === null ? 'it was stopped' : `it was stopped (${death.signal})`;
      expect(framesOfType(frames, 'tool.completed').map((frame) => String(frame.data['output'])).at(-1)).toBe(`Job ${jobId}: ${stopped}.`);
      expect(readDb(home.paths.databases.runtime, TOOL_GROUPS_SQL).length).toBeGreaterThan(0);
      expect(fs.readdirSync(markersOf(home).tools)).toEqual([]);
      await shutdownBarrier(stack);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('bg-runtime-kill'))(titleOf('bg-runtime-kill'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const stack = await startStack({
      home,
      needsBash: true,
      deps: { restart: E2E_RESTART_POLICY },
      script: [toolCallReply('Bash', { command: 'sleep 60', run_in_background: true })],
      routes: jobRoutes(home, (jobId) => toolCallReply('BashOutput', { bash_id: jobId, block: true, timeout: 600_000 }, 'call_output'), 'it is over'),
    });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Start the server');
      await until(() => runRow(home, run.id)?.status === 'WAITING_TOOL', { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the run waits on the job' });
      const jobId = jobIdOf(home);
      if (jobId === undefined) throw new Error('no job was recorded');
      const pgid = jobRow(home, jobId)?.pgid as number;
      expect(await groupRunning(pgid)).toBe(true);

      const before = await stack.client.health();
      const oldRuntimePid = childOf(before, 'runtime').pid;
      if (oldRuntimePid === undefined) throw new Error('runtime has no pid');
      process.kill(oldRuntimePid, 'SIGKILL');
      if (!SANDBOX_ENDS_WITH_RUNTIME[productSandbox()]) expect(await groupRunning(pgid)).toBe(true);

      await untilStatus(runtime, run.id, 'COMPLETED', E2E_RUN_COMPLETED_BOUND_MS);
      await expectEndedAtTerminal('COMPLETED', { group: pgid });
      expect(jobRow(home, jobId)).toMatchObject({ status: 'unknown', exit_code: null, signal: null });
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      expect(framesOfType(frames, 'job.finished').map((frame) => frame.data)).toMatchObject([{ jobId, status: 'unknown' }]);
      const outputs = framesOfType(frames, 'tool.completed').map((frame) => String(frame.data['output']));
      expect(outputs.at(-1)).toContain(`Job ${jobId}: the runtime stopped while it ran, so its result is unknown.`);
      expect(chatCompletions(stack.fake)).toHaveLength(3);
      expect(fs.readdirSync(markersOf(home).tools)).toEqual([]);
      const listed = (await rawGet(home, `/v1/sessions/${session.id}/jobs`)).json['jobs'] as Json[];
      expect(listed).toMatchObject([{ id: jobId, status: 'unknown' }]);
      expect(childOf(await stack.client.health(), 'runtime').restarts).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it.skipIf(skipCase('cli-job-list'))(titleOf('cli-job-list'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const command = 'while [ ! -f release-job ]; do sleep 0.1; done';
    const opened: { home?: E2eHome } = {};
    const { home } = await prepareProduct({
      script: [toolCallReply('Bash', { command, run_in_background: true })],
      routes: jobRoutesIn(() => (opened.home === undefined ? undefined : jobIdOf(opened.home)), (jobId) => toolCallReply('BashOutput', { bash_id: jobId, block: true, timeout: 60_000 }, 'call_output'), 'all done'),
    });
    opened.home = home;

    const running = startCli(home, ['-p', 'Start the build', '--dangerously-skip-permissions']);
    const listed = await until(
      async () => {
        const result = await runCli(home, ['jobs']);
        return result.stdout.includes('  running  ') ? result : undefined;
      },
      { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the running job to be listed by momonga jobs' },
    );
    const jobId = jobIdOf(home);
    if (jobId === undefined) throw new Error('no job was recorded');
    const runId = readDb<{ run_id: string }>(home.paths.databases.runtime, 'SELECT run_id FROM jobs WHERE id = ?', jobId)[0]?.run_id;
    expect(listed.stdout).toBe(`${jobId}  running  run ${runId}  ${command}\n`);
    const status = await runCli(home, ['status', runId ?? '']);
    expect(status.stdout).toBe(`${runId}  WAITING_TOOL\n`);

    fs.writeFileSync(path.join(home.project, 'release-job'), '');
    const finished = await running.result;
    expect(finished.code).toBe(0);
    expect(finished.stdout).toBe('all done\n');
    expect(finished.stderr).toContain(`momonga: waiting for job ${jobId}`);

    const after = await runCli(home, ['jobs']);
    expect(after.stdout).toBe(`${jobId}  exited  exit 0  run ${runId}  ${command}\n`);
    const asJson = await runCli(home, ['jobs', '--json']);
    expect(JSON.parse(asJson.stdout)).toMatchObject([{ id: jobId, status: 'exited', exitCode: 0, command }]);
  });
});
