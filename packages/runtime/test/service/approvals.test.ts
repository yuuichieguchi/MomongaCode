import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callsStep } from '../worker/scripts.ts';
import { DEFAULT_TTL_MS, OPTIONS, START_MS, attachWorkerKit, expectError, requestManualApproval, startService, toolCallPayload } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const askToWrite = async (env: ServiceEnv, runBody: Record<string, unknown> = {}, files: string[] = ['out.txt']) => {
  const kit = attachWorkerKit(env);
  const session = await env.createSession();
  const targets = files.map((file) => path.join(env.layout.projectReal, file));
  kit.gateway.script.push(callsStep(targets.map((target, index) => ({ callId: `call_w_${index + 1}`, name: 'Write', args: { file_path: target, content: 'approved' } }))));
  const run = await env.createRun(session.id, { input: 'Write the files', ...runBody });
  expect(await kit.runOnce(kit.worker())).toBe('yielded');
  const approvals = ((await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals as any[]).sort((left, right) => String(left.callId).localeCompare(String(right.callId)));
  return { kit, session, run, targets, approvals };
};

const optionOf = (approval: { options: { optionId: string; kind: string }[] }, kind: string): string => {
  const option = approval.options.find((candidate) => candidate.kind === kind);
  if (option === undefined) throw new Error(`no ${kind} option`);
  return option.optionId;
};

describe('approval views', () => {
  it('lists the pending approval with its tool call, options and suggested rule', async () => {
    const env = await startService();
    const { kit, run, targets, approvals } = await askToWrite(env);
    const target = targets[0];

    expect(approvals).toHaveLength(1);
    const [approval] = approvals;
    expect(approval).toMatchObject({
      runId: run.id,
      callId: kit.gateway.callId('call_w_1'),
      status: 'pending',
      expiresAt: START_MS + DEFAULT_TTL_MS,
      suggestedRule: `Write(/${target})`,
      toolCall: { callId: kit.gateway.callId('call_w_1'), name: 'Write', title: `Write ${target}`, kind: 'edit', rawInput: { file_path: target, content: 'approved' }, locations: [{ path: target }] },
    });
    expect(approval.options.map((option: { kind: string }) => option.kind).sort()).toEqual(['allow_always', 'allow_once', 'reject_always', 'reject_once']);
    const requested = env.ofType(run.id, 'tool.permission.requested').at(-1);
    expect(approval.id).toBe(requested?.approvalId);
    expect(approval.options).toEqual(requested?.options);

    const single = await env.http('GET', `/v1/approvals/${approval.id}`);
    expect(single.status).toBe(200);
    expect(single.json.approval).toEqual(approval);
  });

  it('serves the reason the policy asked on the listed and the single approval, equal to the journaled request', async () => {
    const env = await startService();
    const { run, approvals } = await askToWrite(env);
    const [approval] = approvals;

    expect(approval?.reason).toBe('edits require approval');
    expect(env.ofType(run.id, 'tool.permission.requested').at(-1)?.reason).toBe('edits require approval');
    const single = await env.http('GET', `/v1/approvals/${approval.id}`);
    expect(single.json.approval.reason).toBe('edits require approval');
  });

  it('answers an unknown approval with 404', async () => {
    const env = await startService();
    expectError(await env.http('GET', '/v1/approvals/apr_missing'), 404, 'not_found');
    expectError(await env.http('POST', '/v1/approvals/apr_missing', { body: { optionId: 'x' } }), 404, 'not_found');
  });

  it('caps the approval expiry at the run deadline', async () => {
    const env = await startService();
    const { approvals } = await askToWrite(env, { timeoutMs: 60_000 });
    expect(approvals[0]?.expiresAt).toBe(START_MS + 60_000);
  });
});

describe('approval resolution', () => {
  it('resolves a pending approval, appends the event and requeues the WAITING_HUMAN run', async () => {
    const env = await startService();
    const { run, approvals } = await askToWrite(env);
    const [approval] = approvals;
    const optionId = optionOf(approval, 'allow_once');

    const response = await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId } });

    expect(response.status).toBe(200);
    expect(response.json.approval).toMatchObject({ id: approval.id, status: 'resolved' });
    expect(response.json.run).toMatchObject({ id: run.id, status: 'QUEUED' });
    expect(env.ofType(run.id, 'tool.permission.resolved')).toEqual([expect.objectContaining({ approvalId: approval.id, optionId })]);
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'WAITING_HUMAN', to: 'QUEUED' });
    expect((await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals).toEqual([]);
  });

  it('keeps the run WAITING_HUMAN until the last of two pending approvals is resolved', async () => {
    const env = await startService();
    const { kit, run, approvals } = await askToWrite(env, {}, ['one.txt', 'two.txt']);
    expect(approvals.map((approval) => approval.callId)).toEqual([kit.gateway.callId('call_w_1'), kit.gateway.callId('call_w_2')]);

    const [first, second] = approvals;
    const afterFirst = await env.http('POST', `/v1/approvals/${first.id}`, { body: { optionId: optionOf(first, 'allow_once') } });
    expect(afterFirst.status).toBe(200);
    expect(afterFirst.json.run.status).toBe('WAITING_HUMAN');
    expect((await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals.map((approval: { id: string }) => approval.id)).toEqual([second.id]);

    const afterSecond = await env.http('POST', `/v1/approvals/${second.id}`, { body: { optionId: optionOf(second, 'reject_once') } });
    expect(afterSecond.status).toBe(200);
    expect(afterSecond.json.run.status).toBe('QUEUED');
  });

  it('rejects a second resolve with 409 approval_not_pending naming the status', async () => {
    const env = await startService();
    const { approvals } = await askToWrite(env);
    const [approval] = approvals;
    const optionId = optionOf(approval, 'allow_once');
    expect((await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId } })).status).toBe(200);

    const again = await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId } });

    expectError(again, 409, 'approval_not_pending');
    expect(again.json.error.type).toBe('conflict');
    expect(again.json.error.message).toContain('resolved');
  });

  it('rejects a superseded approval with 409 naming superseded', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, [toolCallPayload('call_1', path.join(env.layout.projectReal, 'a.txt'))]);
    const first = requestManualApproval(env, claim, 'call_1', START_MS + 60_000);
    const result = env.store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 60_000, event: { subjectDigest: 'b'.repeat(64), reason: 'edits require approval' } });
    expect(result.kind).toBe('ok');
    expect((await env.http('GET', `/v1/approvals/${first}`)).json.approval.status).toBe('superseded');

    const response = await env.http('POST', `/v1/approvals/${first}`, { body: { optionId: OPTIONS[0]?.optionId } });

    expectError(response, 409, 'approval_not_pending');
    expect(response.json.error.message).toContain('superseded');
  });

  it('rejects a withdrawn approval with 409 naming withdrawn', async () => {
    const env = await startService();
    const { run, approvals } = await askToWrite(env);
    const [approval] = approvals;
    expect((await env.http('POST', `/v1/runs/${run.id}/cancel`)).status).toBe(202);

    const response = await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: optionOf(approval, 'allow_once') } });

    expectError(response, 409, 'approval_not_pending');
    expect(response.json.error.message).toContain('withdrawn');
  });

  it('expires an expired-but-unswept approval on resolve and stops the run with approval_timeout', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: 1000 });
    const { run, approvals } = await askToWrite(env);
    const [approval] = approvals;
    env.clock.advance(DEFAULT_TTL_MS);

    const response = await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: optionOf(approval, 'allow_once') } });

    expectError(response, 409, 'approval_not_pending');
    expect(response.json.error.message).toContain('expired');
    expect((await env.http('GET', `/v1/approvals/${approval.id}`)).json.approval.status).toBe('expired');
    expect(await env.getRun(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    expect(env.ofType(run.id, 'tool.permission.cancelled')).toEqual([expect.objectContaining({ approvalId: approval.id, reason: 'expired' })]);
    expect(env.ofType(run.id, 'tool.permission.resolved')).toEqual([]);
  });

  it('rejects a pending approval on a run with cancel requested with 409 run_cancelled', async () => {
    const env = await startService();
    const { run, approvals } = await askToWrite(env);
    const [approval] = approvals;
    env.raw().prepare('UPDATE runs SET cancel_requested = 1 WHERE id = ?').run(run.id);

    const response = await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: optionOf(approval, 'allow_once') } });

    expectError(response, 409, 'run_cancelled');
    expect((await env.http('GET', `/v1/approvals/${approval.id}`)).json.approval.status).toBe('pending');
  });

  it('rejects an option that was not offered with 400', async () => {
    const env = await startService();
    const { approvals } = await askToWrite(env);
    const [approval] = approvals;
    expectError(await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: 'not-offered' } }), 400, 'invalid_request');
    expect((await env.http('GET', `/v1/approvals/${approval.id}`)).json.approval.status).toBe('pending');
  });

  it('rejects a malformed resolve body with 400', async () => {
    const env = await startService();
    const { approvals } = await askToWrite(env);
    const [approval] = approvals;
    expectError(await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: 5 } }), 400, 'invalid_request');
    expectError(await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: optionOf(approval, 'allow_once'), extra: 1 } }), 400, 'invalid_request');
  });

  it('records a resolve while the run is RUNNING and the worker release then requeues it', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, [toolCallPayload('call_1', path.join(env.layout.projectReal, 'a.txt'))]);
    const approvalId = requestManualApproval(env, claim, 'call_1', START_MS + 60_000);

    const response = await env.http('POST', `/v1/approvals/${approvalId}`, { body: { optionId: 'opt-allow-once' } });

    expect(response.status).toBe(200);
    expect(response.json.run.status).toBe('RUNNING');
    expect(env.ofType(run.id, 'tool.permission.resolved')).toEqual([expect.objectContaining({ approvalId, optionId: 'opt-allow-once' })]);
    expect(env.store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    expect((await env.getRun(run.id)).status).toBe('QUEUED');
  });

  it('carries suggestedRule on manually requested approvals and omits it when absent', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    const target = path.join(env.layout.projectReal, 'a.txt');
    env.append(claim, [toolCallPayload('call_1', target), toolCallPayload('call_2', target)]);
    const withRule = requestManualApproval(env, claim, 'call_1', START_MS + 60_000, { suggestedRule: 'Write(/a.txt)' });
    const withoutRule = requestManualApproval(env, claim, 'call_2', START_MS + 60_000);

    expect((await env.http('GET', `/v1/approvals/${withRule}`)).json.approval).toMatchObject({ suggestedRule: 'Write(/a.txt)', toolCall: { callId: 'call_1' } });
    const plain = (await env.http('GET', `/v1/approvals/${withoutRule}`)).json.approval;
    expect(plain).not.toHaveProperty('suggestedRule');
    expect(plain.toolCall).toMatchObject({ callId: 'call_2', name: 'Write' });
  });
});
