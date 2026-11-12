import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Worker } from '@momonga/runtime';
import { callsStep, textStep } from '../worker/scripts.ts';
import { attachWorkerKit, startService, pollFor } from './helpers.ts';
import type { ServiceEnv, WorkerKit } from './helpers.ts';

const REJECTED = 'A person rejected this call, so it was not run.';

const startedKit = (env: ServiceEnv): WorkerKit & { live: Worker } => {
  const kit = attachWorkerKit(env);
  const live = kit.worker('worker-live', { idlePollMs: 10 });
  live.start();
  return { ...kit, live };
};

const optionOf = (approval: { options: { optionId: string; kind: string }[] }, kind: string): string => {
  const option = approval.options.find((candidate) => candidate.kind === kind);
  if (option === undefined) throw new Error(`no ${kind} option`);
  return option.optionId;
};

describe('service and worker over the real socket', () => {
  it('creates a session and a run and streams SSE until COMPLETED', async () => {
    const env = await startService();
    const kit = startedKit(env);
    kit.gateway.script.push(textStep('Hello from the fake model.'));
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'Say hello' });

    const stream = await env.stream(`/v1/runs/${run.id}/events`);
    const frames = await stream.toEnd();

    expect(frames.at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
    expect(frames.filter((event) => event.type === 'agent.message.delta').map((event) => event.text).join('')).toBe('Hello from the fake model.');
    expect(frames.map((event) => event.seq)).toEqual(Array.from({ length: frames.length }, (_, index) => index + 1));
    expect(await env.getRun(run.id)).toMatchObject({ status: 'COMPLETED', lastSeq: frames.length });
    expect(kit.gateway.streams).toHaveLength(1);
  });

  it('returns a reject_once decision to the model through an HTTP approval round trip', async () => {
    const env = await startService();
    const kit = startedKit(env);
    const target = path.join(env.layout.projectReal, 'out.txt');
    kit.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'nope' } }]), textStep('Understood.'));
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'Write the file' });
    const stream = await env.stream(`/v1/runs/${run.id}/events`);

    const untilRequest = await stream.until((event) => event.type === 'tool.permission.requested');
    const requested = untilRequest.at(-1);
    await pollFor(() => env.store.getRun(run.id)?.status === 'WAITING_HUMAN', 10_000, 'the run to wait for a human');
    const [approval] = (await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals;
    expect(approval.id).toBe(requested?.approvalId);

    const resolved = await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: optionOf(approval, 'reject_once') } });
    expect(resolved.status).toBe(200);

    const rest = await stream.toEnd();
    expect(rest.at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
    expect(rest.find((event) => event.type === 'tool.completed')).toMatchObject({ callId: kit.gateway.callId('call_w_1'), status: 'failed', output: REJECTED });
    expect(fs.existsSync(target)).toBe(false);
    const input = kit.gateway.streams[1]?.body.input;
    expect(Array.isArray(input) && input.some((item) => item.type === 'function_call_output' && item.call_id === kit.gateway.callId('call_w_1') && item.output === REJECTED)).toBe(true);
  });

  it('persists an allow_always rule so the next run gets no prompt', async () => {
    const env = await startService();
    const kit = startedKit(env);
    const target = path.join(env.layout.projectReal, 'out.txt');
    kit.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'first' } }]), textStep('Written.'));
    const session = await env.createSession();
    const first = await env.createRun(session.id, { input: 'Write the file' });
    const firstStream = await env.stream(`/v1/runs/${first.id}/events`);
    await firstStream.until((event) => event.type === 'tool.permission.requested');
    await pollFor(() => env.store.getRun(first.id)?.status === 'WAITING_HUMAN', 10_000, 'the first run to wait for a human');
    const [approval] = (await env.http('GET', `/v1/runs/${first.id}/approvals`)).json.approvals;
    expect((await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: optionOf(approval, 'allow_always') } })).status).toBe(200);
    expect((await firstStream.toEnd()).at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
    expect(kit.settings.appended).toEqual([{ sessionId: session.id, effect: 'allow', rule: `Write(/${target})` }]);
    expect(fs.readFileSync(target, 'utf8')).toBe('first');

    kit.gateway.script.push(callsStep([{ callId: 'call_w_2', name: 'Write', args: { file_path: target, content: 'second' } }]), textStep('Written again.'));
    const second = await env.createRun(session.id, { input: 'Write it again' });
    const secondFrames = await (await env.stream(`/v1/runs/${second.id}/events`)).toEnd();

    expect(secondFrames.at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
    expect(secondFrames.map((event) => event.type)).not.toContain('tool.permission.requested');
    expect(fs.readFileSync(target, 'utf8')).toBe('second');
  });

  it('cancels a run during a long tool within 3 s, ends the stream and makes no further gateway call', async () => {
    const env = await startService();
    const kit = startedKit(env);
    kit.gateway.script.push(callsStep([{ callId: 'call_wait', name: 'Wait', args: { value: 'forever' } }]), textStep('should never be requested'));
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'Wait for a while' });
    const stream = await env.stream(`/v1/runs/${run.id}/events`);
    await kit.toolbox.waitStarted.promise;
    const gatewayCallsAtCancel = kit.gateway.streams.length;

    const cancel = await env.http('POST', `/v1/runs/${run.id}/cancel`);
    expect(cancel.status).toBe(202);
    expect(cancel.json.run.status).toBe('CANCELLING');

    await pollFor(() => env.store.getRun(run.id)?.status === 'CANCELLED', 3_000, 'the run to reach CANCELLED');
    const rest = await stream.toEnd();
    expect(rest.at(-1)).toMatchObject({ type: 'run.status', to: 'CANCELLED' });
    expect(kit.toolbox.waitSignals.every((signal) => signal.aborted)).toBe(true);
    await kit.live.stop();
    expect(kit.gateway.streams).toHaveLength(gatewayCallsAtCancel);
  });
});
