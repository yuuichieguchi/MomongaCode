import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { envelopeOf } from '@momonga/protocol';
import { titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import type { RunEventFrame, RuntimeClient } from './support/runtime-client.ts';
import { startStack } from './support/stack.ts';
import { chatCompletions, messagesOf, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const REJECTED_OUTPUT = 'The user rejected this tool call.';
const WRITTEN_CONTENT = 'written by the model\n';

const writeCall = (file: string) => toolCallReply('Write', { file_path: file, content: WRITTEN_CONTENT });

const runToEnd = async (runtime: RuntimeClient, runId: string): Promise<RunEventFrame[]> => {
  const stream = runtime.events(runId);
  const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
  await stream.close();
  return frames;
};

const TERMINAL_STATUSES: ReadonlySet<unknown> = new Set(['COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED']);

const unpromptedRunToEnd = async (runtime: RuntimeClient, runId: string): Promise<RunEventFrame[]> => {
  const stream = runtime.events(runId);
  const decisive = await stream.until(
    (frame) => frame.data.type === 'tool.permission.requested' || (frame.data.type === 'run.status' && TERMINAL_STATUSES.has(frame.data['to'])),
    E2E_RUN_COMPLETED_BOUND_MS,
  );
  expect(decisive.data.type).not.toBe('tool.permission.requested');
  const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
  await stream.close();
  return frames;
};

const pendingApprovalOf = async (runtime: RuntimeClient, runId: string): Promise<RunEventFrame> => {
  const stream = runtime.events(runId);
  const requested = await stream.until((frame) => frame.data.type === 'tool.permission.requested', E2E_RUN_COMPLETED_BOUND_MS);
  await stream.close();
  return requested;
};

const approvalIdOf = (frame: RunEventFrame): string => {
  const approvalId = frame.data['approvalId'];
  if (typeof approvalId !== 'string') throw new Error(`tool.permission.requested without an approvalId: ${JSON.stringify(frame.data)}`);
  return approvalId;
};

const startDefaultRun = async (runtime: RuntimeClient, input: string): Promise<string> => {
  const { session } = await runtime.createSession({ permissionMode: 'default' });
  return (await runtime.createRun(session.id, input)).run.id;
};

const localSettingsFileOf = (home: E2eHome): string => path.join(home.paths.projects, sha256Hex(fs.realpathSync.native(home.project)), 'settings.local.json');

const localRulesOf = (home: E2eHome): unknown => JSON.parse(fs.readFileSync(localSettingsFileOf(home), 'utf8'));

const finalStatusOf = (frames: readonly RunEventFrame[]): unknown => frames.at(-1)?.data['to'];

describe('d: approvals', () => {
  it(titleOf('d-reject-once'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const target = path.join(home.project, 'rejected.txt');
    const stack = await startStack({ home, script: [writeCall(target), textReply('understood')] });
    const runtime = createRuntimeClient(home);
    try {
      const runId = await startDefaultRun(runtime, 'Write the file');
      const requested = await pendingApprovalOf(runtime, runId);
      const approvalId = approvalIdOf(requested);
      expect((await runtime.getRun(runId)).run.status).toBe('WAITING_HUMAN');
      expect((await runtime.approvals(runId)).map((approval) => approval.id)).toEqual([approvalId]);

      const notOffered = await runtime.resolveApproval(approvalId, 'allow_forever');
      expect(notOffered.status).toBe(400);
      expect(notOffered.body).toMatchObject({ error: { param: 'optionId' } });

      const rejected = await runtime.resolveApproval(approvalId, 'reject_once');
      expect(rejected.status).toBe(200);
      expect(rejected.body).toMatchObject({ approval: { id: approvalId, status: 'resolved' } });

      const again = await runtime.resolveApproval(approvalId, 'reject_once');
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: { code: 'approval_not_pending' } });

      const frames = await runToEnd(runtime, runId);
      expect(finalStatusOf(frames)).toBe('COMPLETED');
      expect(framesOfType(frames, 'tool.permission.resolved').map((frame) => frame.data['optionId'])).toEqual(['reject_once']);
      expect(framesOfType(frames, 'approval.rule.persisted')).toEqual([]);
      expect(fs.existsSync(localSettingsFileOf(home))).toBe(false);
      expect(fs.existsSync(target)).toBe(false);

      const calls = chatCompletions(stack.fake);
      expect(calls).toHaveLength(2);
      const lastMessage = messagesOf(calls[1]).at(-1);
      expect(lastMessage?.role).toBe('tool');
      expect(lastMessage?.content).toBe(envelopeOf({ content: REJECTED_OUTPUT, callId: String(lastMessage?.tool_call_id), tool: 'Write' }));
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('d-allow-always'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const target = path.join(home.project, 'allowed.txt');
    const stack = await startStack({ home, script: [writeCall(target), textReply('first write'), writeCall(target), textReply('second write')] });
    const runtime = createRuntimeClient(home);
    try {
      const firstRun = await startDefaultRun(runtime, 'Write the file');
      const approvalId = approvalIdOf(await pendingApprovalOf(runtime, firstRun));
      expect((await runtime.resolveApproval(approvalId, 'allow_always')).status).toBe(200);
      const firstFrames = await runToEnd(runtime, firstRun);
      expect(finalStatusOf(firstFrames)).toBe('COMPLETED');

      const persisted = framesOfType(firstFrames, 'approval.rule.persisted');
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.data).toMatchObject({ approvalId, effect: 'allow' });
      const rule = persisted[0]?.data['rule'];
      expect(typeof rule).toBe('string');
      expect(localRulesOf(home)).toEqual({ permissions: { allow: [rule] } });
      expect(fs.readFileSync(target, 'utf8')).toBe(WRITTEN_CONTENT);

      fs.rmSync(target);
      const secondRun = await startDefaultRun(runtime, 'Write the file again');
      const secondFrames = await unpromptedRunToEnd(runtime, secondRun);
      expect(finalStatusOf(secondFrames)).toBe('COMPLETED');
      expect(framesOfType(secondFrames, 'tool.permission.requested')).toEqual([]);
      expect(framesOfType(secondFrames, 'tool.completed').map((frame) => frame.data['status'])).toEqual(['completed']);
      expect(fs.readFileSync(target, 'utf8')).toBe(WRITTEN_CONTENT);
      expect(chatCompletions(stack.fake)).toHaveLength(4);
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('d-reject-always'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const target = path.join(home.project, 'denied.txt');
    const stack = await startStack({ home, script: [writeCall(target), textReply('first refusal'), writeCall(target), textReply('second refusal')] });
    const runtime = createRuntimeClient(home);
    try {
      const firstRun = await startDefaultRun(runtime, 'Write the file');
      const approvalId = approvalIdOf(await pendingApprovalOf(runtime, firstRun));
      expect((await runtime.resolveApproval(approvalId, 'reject_always')).status).toBe(200);
      const firstFrames = await runToEnd(runtime, firstRun);
      expect(finalStatusOf(firstFrames)).toBe('COMPLETED');

      const persisted = framesOfType(firstFrames, 'approval.rule.persisted');
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.data).toMatchObject({ approvalId, effect: 'deny' });
      const rule = persisted[0]?.data['rule'];
      expect(typeof rule).toBe('string');
      expect(localRulesOf(home)).toEqual({ permissions: { deny: [rule] } });
      expect(fs.existsSync(target)).toBe(false);

      const secondRun = await startDefaultRun(runtime, 'Write the file again');
      const secondFrames = await unpromptedRunToEnd(runtime, secondRun);
      expect(finalStatusOf(secondFrames)).toBe('COMPLETED');
      expect(framesOfType(secondFrames, 'tool.permission.requested')).toEqual([]);
      expect(framesOfType(secondFrames, 'tool.completed').map((frame) => frame.data['status'])).toEqual(['failed']);
      expect(fs.existsSync(target)).toBe(false);
      expect(chatCompletions(stack.fake)).toHaveLength(4);
    } finally {
      await runtime.close();
    }
  });
});
