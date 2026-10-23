import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as runtime from '@momonga/runtime';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import { callsStep } from '../worker/scripts.ts';
import { DEFAULT_TTL_MS, START_MS, attachWorkerKit, requestManualApproval, startService, toolCallPayload } from './helpers.ts';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Sweeper = { close(): void | Promise<void> };

const startSweeper = (options: Record<string, unknown>): Sweeper => {
  const start = (runtime as Record<string, unknown>)['startApprovalSweeper'];
  if (typeof start !== 'function') throw new Error('@momonga/runtime does not export startApprovalSweeper');
  return start(options) as Sweeper;
};

describe('startApprovalSweeper', () => {
  it('calls expireApprovals with the clock time every interval, survives errors and stops on close', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const calls: number[] = [];
    const errors: unknown[] = [];
    const failure = new Error('sweep failed');
    const store = {
      expireApprovals: (now: number): string[] => {
        calls.push(now);
        if (now === START_MS + 1000) throw failure;
        return [];
      },
    };

    const sweeper = startSweeper({ store, clock, timers, intervalMs: 1000, onError: (error: unknown) => errors.push(error) });

    timers.advance(1000);
    await flush();
    expect(calls.filter((now) => now !== START_MS)).toEqual([START_MS + 1000]);
    expect(errors).toEqual([failure]);
    timers.advance(1000);
    await flush();
    expect(calls.filter((now) => now !== START_MS)).toEqual([START_MS + 1000, START_MS + 2000]);
    timers.advance(3000);
    await flush();
    expect(calls.filter((now) => now !== START_MS)).toEqual([START_MS + 1000, START_MS + 2000, START_MS + 3000, START_MS + 4000, START_MS + 5000]);
    expect(errors).toEqual([failure]);

    await sweeper.close();
    const callsAtClose = calls.length;
    timers.advance(5000);
    await flush();
    expect(calls).toHaveLength(callsAtClose);
    expect(timers.pending()).toEqual([]);
  });
});

describe('sweeper inside the run service', () => {
  it('expires a pending approval, appends the cancelled event and the notice, and stops the run with approval_timeout', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: 1000 });
    const timers = env.timers;
    if (timers === undefined) throw new Error('fake timers missing');
    const kit = attachWorkerKit(env);
    const session = await env.createSession();
    kit.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.layout.projectReal, 'out.txt'), content: 'x' } }]));
    const run = await env.createRun(session.id, { input: 'Write the file' });
    expect(await kit.runOnce(kit.worker())).toBe('yielded');
    const [approval] = (await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals;
    const before = (await env.getRun(run.id)).lastSeq as number;

    timers.advance(DEFAULT_TTL_MS - 1000);
    expect((await env.getRun(run.id)).status).toBe('WAITING_HUMAN');
    timers.advance(1000);

    expect(await env.getRun(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    expect((await env.http('GET', `/v1/approvals/${approval.id}`)).json.approval.status).toBe('expired');
    const after = env.runEvents(run.id).filter((event) => event.seq > before);
    expect(after.map((event) => event.type)).toEqual(['tool.permission.cancelled', 'notice', 'run.status']);
    expect(after[0]).toMatchObject({ approvalId: approval.id, reason: 'expired' });
    expect(after[1]).toMatchObject({ message: 'The approval for call_w_1 expired.' });
    expect(after[2]).toMatchObject({ from: 'WAITING_HUMAN', to: 'STOPPED' });
  });

  it('stops a WAITING_HUMAN run whose deadline passed with timeout and withdraws its approvals', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: 1000 });
    const timers = env.timers;
    if (timers === undefined) throw new Error('fake timers missing');
    const session = await env.createSession();
    const run = await env.createRun(session.id, { timeoutMs: 60_000 });
    const claim = env.claimRun(run.id);
    env.append(claim, [toolCallPayload('call_1', path.join(env.layout.projectReal, 'a.txt'))]);
    const approvalId = requestManualApproval(env, claim, 'call_1', START_MS + 10 * 60_000);
    expect(env.store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    expect((await env.getRun(run.id)).status).toBe('WAITING_HUMAN');

    timers.advance(60_000);

    expect(await env.getRun(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect((await env.http('GET', `/v1/approvals/${approvalId}`)).json.approval.status).toBe('withdrawn');
    expect(env.ofType(run.id, 'tool.permission.cancelled')).toEqual([expect.objectContaining({ approvalId, reason: 'withdrawn' })]);
  });

  it('leaves expired approvals of RUNNING runs untouched', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: 1000 });
    const timers = env.timers;
    if (timers === undefined) throw new Error('fake timers missing');
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, [toolCallPayload('call_1', path.join(env.layout.projectReal, 'a.txt'))]);
    const approvalId = requestManualApproval(env, claim, 'call_1', START_MS + 2000);
    const before = (await env.getRun(run.id)).lastSeq;

    timers.advance(5000);

    expect((await env.getRun(run.id)).status).toBe('RUNNING');
    expect((await env.getRun(run.id)).lastSeq).toBe(before);
    expect((await env.http('GET', `/v1/approvals/${approvalId}`)).json.approval.status).toBe('pending');
  });
});
