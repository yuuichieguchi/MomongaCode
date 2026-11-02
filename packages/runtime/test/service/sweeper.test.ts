import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as runtime from '@momonga/runtime';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { callsStep } from '../worker/scripts.ts';
import { DEFAULT_TTL_MS, START_MS, attachWorkerKit, requestManualApproval, startService, toolCallPayload } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

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

    const sweeper = startSweeper({ store, clock, timers, intervalMs: 1000, releaseStopped: async () => undefined, onError: (error: unknown) => errors.push(error) });

    timers.advance(1000);
    await afterMicrotasks();
    expect(calls.filter((now) => now !== START_MS)).toEqual([START_MS + 1000]);
    expect(errors).toEqual([failure]);
    timers.advance(1000);
    await afterMicrotasks();
    expect(calls.filter((now) => now !== START_MS)).toEqual([START_MS + 1000, START_MS + 2000]);
    timers.advance(3000);
    await afterMicrotasks();
    expect(calls.filter((now) => now !== START_MS)).toEqual([START_MS + 1000, START_MS + 2000, START_MS + 3000, START_MS + 4000, START_MS + 5000]);
    expect(errors).toEqual([failure]);

    await sweeper.close();
    const callsAtClose = calls.length;
    timers.advance(5000);
    await afterMicrotasks();
    expect(calls).toHaveLength(callsAtClose);
    expect(timers.pending()).toEqual([]);
  });
});

describe('startApprovalSweeper release of stopped runs', () => {
  it('releases every run it stopped, reports a failed release and keeps sweeping, and aborts pending releases on close', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const released: string[] = [];
    const signals: AbortSignal[] = [];
    const errors: unknown[] = [];
    const failure = new Error('release failed');
    let stopped: string[] = ['run-a', 'run-b'];
    const store = {
      expireApprovals: (): string[] => {
        const now = stopped;
        stopped = [];
        return now;
      },
    };
    const sweeper = startSweeper({
      store,
      clock,
      timers,
      intervalMs: 1000,
      releaseStopped: async (runId: string, signal: AbortSignal) => {
        released.push(runId);
        signals.push(signal);
        if (runId === 'run-a') throw failure;
      },
      onError: (error: unknown) => errors.push(error),
    });

    timers.advance(1000);
    await sweeper.close();

    expect(released).toEqual(['run-a', 'run-b']);
    expect(errors).toEqual([failure]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
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
    expect(after[1]).toMatchObject({ message: `The approval for ${kit.gateway.callId('call_w_1')} expired.` });
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

describe('release of runs that stop while waiting for input', () => {
  const REQUESTS = [{ key: 'who', mode: 'form' as const, message: 'Who?', requestedSchema: { type: 'object' } }];

  const waitingForInput = async (env: ServiceEnv, expiresAt: number) => {
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, [toolCallPayload('call_1', path.join(env.layout.projectReal, 'a.txt'))]);
    const requested = env.store.requestElicitation(claim, { callId: 'call_1', expiresAt, server: 'remote', requests: REQUESTS });
    if (requested.kind !== 'ok') throw new Error('expected an elicitation');
    expect(env.store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    return { run, id: requested.approval.id };
  };

  it('releases a run whose request for input expired', async () => {
    const releases: string[] = [];
    const env = await startService({ fakeTimers: true, sweepIntervalMs: 1000, releaseStopped: async (runId) => void releases.push(runId) });
    const timers = env.timers;
    if (timers === undefined) throw new Error('fake timers missing');
    const { run } = await waitingForInput(env, START_MS + 5000);

    timers.advance(5000);

    expect(await env.getRun(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    expect(releases).toEqual([run.id]);
  });

  it('releases a waiting run that the client cancels and reports a failed release without failing the cancel', async () => {
    const failure = new Error('the server is unreachable');
    const releases: string[] = [];
    const env = await startService({
      releaseStopped: async (runId) => {
        releases.push(runId);
        throw failure;
      },
    });
    const { run } = await waitingForInput(env, START_MS + 60_000);

    const cancelled = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(cancelled.status).toBe(202);
    expect(cancelled.json.run.status).toBe('CANCELLED');
    await vi.waitFor(() => expect(env.errors).toContain(failure));
    expect(releases).toEqual([run.id]);
  });

  it('does not release a run that is cancelled while running or that is already terminal', async () => {
    const releases: string[] = [];
    const env = await startService({ releaseStopped: async (runId) => void releases.push(runId) });
    const session = await env.createSession();
    const running = await env.createRun(session.id);
    env.claimRun(running.id);

    await env.http('POST', `/v1/runs/${running.id}/cancel`);
    await env.http('POST', `/v1/runs/${running.id}/cancel`);

    expect(releases).toEqual([]);
  });
});
