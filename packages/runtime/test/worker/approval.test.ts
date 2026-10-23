import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { START_MS, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const REJECTED = 'The user rejected this tool call.';
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const askToWrite = async (env: Env, target = path.join(env.project, 'out.txt'), limits: Record<string, unknown> = {}) => {
  env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'approved' } }]));
  const run = env.enqueue('Write the file', { limits });
  expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
  return { run, target };
};

describe('worker approval request', () => {
  it('creates an approval, records the request with all four options and releases to WAITING_HUMAN', async () => {
    const env = await makeEnv();
    const { run, target } = await askToWrite(env);

    const current = env.run(run.id);
    expect(current.status).toBe('WAITING_HUMAN');
    expect(current.leaseOwner).toBeNull();
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'RUNNING', to: 'WAITING_HUMAN' });

    const requests = env.ofType(run.id, 'tool.permission.requested');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (request === undefined) throw new Error('expected a permission request');
    expect(request.callId).toBe('call_w_1');
    expect(request.options.map((option) => option.kind).sort()).toEqual(['allow_always', 'allow_once', 'reject_always', 'reject_once']);
    expect(new Set(request.options.map((option) => option.optionId)).size).toBe(4);
    expect(request.subjectDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(request.suggestedRule).toBe(`Write(/${target})`);

    const pending = env.store.approvals.listPending(run.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: request.approvalId, callId: 'call_w_1', expiresAt: START_MS + DEFAULT_TTL_MS });
    expect(pending[0]?.options).toEqual(request.options);

    expect(env.fold(run.id).pendingCalls['call_w_1']).toMatchObject({ status: 'awaiting_approval', suggestedRule: `Write(/${target})` });
    expect(fs.existsSync(target)).toBe(false);
    expect(env.toolbox.executions).toEqual([]);
  });

  it('offers only the once options when there is no suggested rule', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_b_1', name: 'Bash', args: { command: 'echo $(date)' } }]));
    const run = env.enqueue('Run it');

    await env.runOnce(env.worker());

    const [request] = env.ofType(run.id, 'tool.permission.requested');
    expect(request?.options.map((option) => option.kind).sort()).toEqual(['allow_once', 'reject_once']);
    expect(request).not.toHaveProperty('suggestedRule');
  });

  it('uses approvalTtlMs from run.limits for the approval expiry', async () => {
    const env = await makeEnv();
    const { run } = await askToWrite(env, undefined, { approvalTtlMs: 123_000 });
    expect(env.store.approvals.listPending(run.id)[0]?.expiresAt).toBe(START_MS + 123_000);
  });
});

describe('worker approval resume', () => {
  it('runs the call on allow_once and does not persist a rule', async () => {
    const env = await makeEnv();
    const { run, target } = await askToWrite(env);
    env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));

    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(target, 'utf8')).toBe('approved');
    expect(env.ofType(run.id, 'tool.completed')).toEqual([expect.objectContaining({ callId: 'call_w_1', status: 'completed', output: `wrote ${target}` })]);
    expect(env.settings.appended).toEqual([]);
    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
  });

  it('persists an allow rule on allow_always, notes it and runs the call', async () => {
    const env = await makeEnv();
    const { run, target } = await askToWrite(env);
    const rule = `Write(/${target})`;
    const noticesBefore = env.ofType(run.id, 'notice').length;
    env.resolveApproval(run.id, 'allow_always');
    env.gateway.script.push(textStep('Written.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.settings.appended).toEqual([{ sessionId: env.session.id, effect: 'allow', rule }]);
    expect(env.ofType(run.id, 'notice').length).toBeGreaterThan(noticesBefore);
    expect(fs.readFileSync(target, 'utf8')).toBe('approved');
  });

  it('persists the allow rule once and no longer asks for the same subject in a later run', async () => {
    const env = await makeEnv();
    const { run, target } = await askToWrite(env);
    env.resolveApproval(run.id, 'allow_always');
    env.gateway.script.push(textStep('Written.'));
    await env.runOnce(env.worker('worker-2'));

    env.gateway.script.push(callsStep([{ callId: 'call_w_2', name: 'Write', args: { file_path: target, content: 'again' } }]), textStep('Written again.'));
    const second = env.enqueue('Write it again');
    await env.runOnce(env.worker('worker-3'));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(env.ofType(second.id, 'tool.permission.requested')).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('again');
    expect(env.settings.stored).toEqual([{ effect: 'allow', rule: `Write(/${target})` }]);
  });

  it.each(['reject_once', 'reject_always'] as const)('fails the call with the rejection output on %s and continues', async (kind) => {
    const env = await makeEnv();
    const { run, target } = await askToWrite(env);
    env.resolveApproval(run.id, kind);
    env.gateway.script.push(textStep('Understood.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.completed')).toEqual([expect.objectContaining({ callId: 'call_w_1', status: 'failed', output: REJECTED })]);
    expect(fs.existsSync(target)).toBe(false);
    expect(env.toolbox.executions).toEqual([]);
    const input = env.gateway.streams[1]?.body.input;
    expect(Array.isArray(input) && input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_w_1' && item.output === REJECTED)).toBe(true);
    if (kind === 'reject_always') {
      expect(env.settings.appended).toEqual([{ sessionId: env.session.id, effect: 'deny', rule: `Write(/${target})` }]);
    } else {
      expect(env.settings.appended).toEqual([]);
    }
  });

  it('asks again with a new approval when the subject changed after approval', async () => {
    const env = await makeEnv();
    const directory = path.join(env.project, 'dir');
    const other = path.join(env.project, 'other');
    fs.mkdirSync(directory);
    fs.mkdirSync(other);
    const { run } = await askToWrite(env, path.join(directory, 'out.txt'));
    const [firstRequest] = env.ofType(run.id, 'tool.permission.requested');
    fs.rmSync(directory, { recursive: true });
    fs.symlinkSync(other, directory, 'dir');
    env.resolveApproval(run.id, 'allow_once');

    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const requests = env.ofType(run.id, 'tool.permission.requested');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.callId).toBe('call_w_1');
    expect(requests[1]?.subjectDigest).not.toBe(firstRequest?.subjectDigest);
    expect(requests[1]?.approvalId).not.toBe(firstRequest?.approvalId);
    const pending = env.store.approvals.listPending(run.id);
    expect(pending.map((approval) => approval.id)).toEqual([requests[1]?.approvalId]);
    expect(fs.existsSync(path.join(other, 'out.txt'))).toBe(false);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('decides rejection from the resolution kind, not the call status', async () => {
    const env = await makeEnv();
    const { run } = await askToWrite(env);
    env.resolveApproval(run.id, 'reject_once');
    expect(env.fold(run.id).pendingCalls['call_w_1']).toMatchObject({ status: 'requested', resolution: { kind: 'reject_once' } });
    env.gateway.script.push(textStep('Understood.'));

    await env.runOnce(env.worker('worker-2'));

    expect(env.toolbox.executions).toEqual([]);
    expect(env.ofType(run.id, 'tool.started')).toEqual([]);
  });
});
