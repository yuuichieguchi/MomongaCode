import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callsStep } from '../worker/scripts.ts';
import { START_MS, attachWorkerKit, expectError, requestManualApproval, startService, toolCallPayload } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const waitingRun = async (env: ServiceEnv) => {
  const kit = attachWorkerKit(env);
  const session = await env.createSession();
  kit.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.layout.projectReal, 'out.txt'), content: 'x' } }]));
  const run = await env.createRun(session.id, { input: 'Write the file' });
  expect(await kit.runOnce(kit.worker())).toBe('yielded');
  expect((await env.getRun(run.id)).status).toBe('WAITING_HUMAN');
  return { kit, session, run };
};

const typesAfter = (env: ServiceEnv, runId: string, seq: number): string[] => env.runEvents(runId).filter((event) => event.seq > seq).map((event) => event.type);

describe('cancel', () => {
  it('answers a cancel of a QUEUED run with 202 and CANCELLING, and starts neither the upstream cancel nor the release in the request', async () => {
    const upstream: string[] = [];
    const released: string[] = [];
    const env = await startService({
      cancelUpstream: async (runId: string) => void upstream.push(runId),
      releaseStopped: async (runId: string) => void released.push(runId),
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id);

    const response = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(response.status).toBe(202);
    expect(response.json.run).toMatchObject({ id: run.id, status: 'CANCELLING', cancelRequested: true });
    expect((await env.getRun(run.id)).status).toBe('CANCELLING');
    expect(upstream).toEqual([]);
    expect(released).toEqual([]);
  });

  it('moves a RUNNING run to CANCELLING and withdraws its pending approvals with the cancelled event first', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    const target = path.join(env.layout.projectReal, 'a.txt');
    env.append(claim, [toolCallPayload('call_1', target)]);
    const approvalId = await requestManualApproval(env, claim, 'call_1');
    const before = (await env.getRun(run.id)).lastSeq as number;

    const response = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(response.status).toBe(202);
    expect(response.json.run).toMatchObject({ status: 'CANCELLING', cancelRequested: true });
    expect((await env.http('GET', `/v1/runs/${run.id}/approvals`)).json).toEqual({ approvals: [], settled: [expect.objectContaining({ id: approvalId, status: 'withdrawn' })] });
    expect((await env.http('GET', `/v1/approvals/${approvalId}`)).json.approval.status).toBe('withdrawn');
    expect(env.ofType(run.id, 'tool.permission.cancelled')).toEqual([expect.objectContaining({ approvalId, reason: 'withdrawn' })]);
    expect(typesAfter(env, run.id, before)).toEqual(['tool.permission.cancelled', 'run.status']);
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'RUNNING', to: 'CANCELLING' });
  });

  it('answers a cancel of a WAITING_HUMAN run with 202 and CANCELLING and withdraws its approvals', async () => {
    const env = await startService();
    const { run } = await waitingRun(env);
    const [pending] = (await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals;
    const before = (await env.getRun(run.id)).lastSeq as number;

    const response = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(response.status).toBe(202);
    expect(response.json.run).toMatchObject({ status: 'CANCELLING', cancelRequested: true });
    expect((await env.http('GET', `/v1/approvals/${pending.id}`)).json.approval.status).toBe('withdrawn');
    expect((await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals).toEqual([]);
    expect(typesAfter(env, run.id, before)).toEqual(['tool.permission.cancelled', 'run.status']);
    expect(env.ofType(run.id, 'tool.permission.cancelled').at(-1)).toMatchObject({ approvalId: pending.id, reason: 'withdrawn' });
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'WAITING_HUMAN', to: 'CANCELLING' });
  });

  it('keeps a CANCELLING run CANCELLING with 202', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    env.claimRun(run.id);
    expect((await env.http('POST', `/v1/runs/${run.id}/cancel`)).json.run.status).toBe('CANCELLING');
    const before = (await env.getRun(run.id)).lastSeq;

    const again = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(again.status).toBe(202);
    expect(again.json.run.status).toBe('CANCELLING');
    expect((await env.getRun(run.id)).lastSeq).toBe(before);
  });

  it('answers a terminal run with 200 and leaves it unchanged', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    await env.http('POST', `/v1/runs/${run.id}/cancel`);
    expect(await env.store.finishCancelled(() => undefined)).toEqual([run.id]);
    const terminal = await env.getRun(run.id);

    const again = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(again.status).toBe(200);
    expect(again.json.run).toEqual(terminal);
    expect(await env.getRun(run.id)).toEqual(terminal);
  });

  it('answers an unknown run with 404', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/runs/run_missing/cancel'), 404, 'not_found');
  });

  it('ignores the content type because cancel takes no body', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const response = await env.http('POST', `/v1/runs/${run.id}/cancel`, { headers: { 'content-type': 'text/plain' } });
    expect(response.status).toBe(202);
  });
});
