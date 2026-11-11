import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { afterMicrotasks } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { callsStep } from '../worker/scripts.ts';
import { FORMER_APPROVAL_LIMIT_MS, HOUR_MS, attachWorkerKit, startService } from './helpers.ts';
import type { ServiceEnv, WorkerKit } from './helpers.ts';

const DAY_MS = 24 * HOUR_MS;
const LONGEST_RUN_MS = 7 * DAY_MS;

const advance = async (timers: FakeTimers, ms: number, step: number): Promise<void> => {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await timers.advanceAsync(step);
    await afterMicrotasks();
  }
};

const requireTimers = (env: ServiceEnv): FakeTimers => {
  if (env.timers === undefined) throw new Error('fake timers missing');
  return env.timers;
};

const waitingOnWrite = async (env: ServiceEnv, kit: WorkerKit) => {
  const session = await env.createSession();
  kit.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.layout.projectReal, 'out.txt'), content: 'x' } }]));
  const run = await env.createRun(session.id, { input: 'Write the file', timeoutMs: LONGEST_RUN_MS });
  expect(await kit.runOnce(kit.worker())).toBe('yielded');
  const [approval] = (await env.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals;
  return { run, approval };
};

const footprint = (env: ServiceEnv, timers: FakeTimers, runId: string) => {
  const db = env.raw();
  return {
    timers: timers.pending().length,
    approvals: Number(db.prepare('SELECT COUNT(*) AS n FROM approvals').get()?.['n']),
    events: Number(db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?').get(runId)?.['n']),
  };
};

describe('an approval waits for the person with no product time limit', () => {
  it('stays pending through every sweep until just before the run ends, while no timer, row or event grows, and still accepts the answer', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: HOUR_MS, dataVersionPollMs: HOUR_MS });
    const timers = requireTimers(env);
    const kit = attachWorkerKit(env);
    const { run, approval } = await waitingOnWrite(env, kit);
    const worker = kit.worker('worker-idle');
    const baseline = footprint(env, timers, run.id);
    const memories = worker.memorySize();

    for (let day = 0; day < 6; day += 1) {
      await advance(timers, DAY_MS, HOUR_MS);
      expect(await kit.runOnce(worker)).toBe('idle');
      expect(footprint(env, timers, run.id)).toEqual(baseline);
      expect(worker.memorySize()).toBe(memories);
    }
    await advance(timers, DAY_MS - HOUR_MS, HOUR_MS);

    expect(await env.getRun(run.id)).toMatchObject({ status: 'WAITING_HUMAN' });
    expect((await env.http('GET', `/v1/approvals/${approval.id}`)).json.approval.status).toBe('pending');
    expect(footprint(env, timers, run.id)).toEqual(baseline);

    const answered = await env.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: approval.options[0].optionId } });
    expect(answered.status).toBe(200);
    expect(answered.json.run).toMatchObject({ id: run.id, status: 'QUEUED' });
  });

  it('keeps the approval answerable after the former 30-minute limit, with no expiry notice', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: 60_000, dataVersionPollMs: 60_000 });
    const timers = requireTimers(env);
    const kit = attachWorkerKit(env);
    const { run, approval } = await waitingOnWrite(env, kit);

    await advance(timers, FORMER_APPROVAL_LIMIT_MS + 60_000, 60_000);

    expect(await env.getRun(run.id)).toMatchObject({ status: 'WAITING_HUMAN' });
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'approval_expired')).toEqual([]);
    expect(env.ofType(run.id, 'tool.permission.cancelled')).toEqual([]);
    expect(approval).not.toHaveProperty('expiresAt');
  });

  it('ends when the person cancels the run', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: HOUR_MS, dataVersionPollMs: HOUR_MS });
    const timers = requireTimers(env);
    const kit = attachWorkerKit(env);
    const { run, approval } = await waitingOnWrite(env, kit);
    await advance(timers, 2 * DAY_MS, HOUR_MS);

    expect((await env.http('POST', `/v1/runs/${run.id}/cancel`)).status).toBe(202);

    expect((await env.http('GET', `/v1/approvals/${approval.id}`)).json.approval.status).toBe('withdrawn');
    expect(env.ofType(run.id, 'tool.permission.cancelled')).toEqual([expect.objectContaining({ approvalId: approval.id, reason: 'withdrawn' })]);
  });

  it('ends when the run reaches its deadline: the run stops with timeout and the approval is withdrawn', async () => {
    const env = await startService({ fakeTimers: true, sweepIntervalMs: HOUR_MS, dataVersionPollMs: HOUR_MS });
    const timers = requireTimers(env);
    const kit = attachWorkerKit(env);
    const { run, approval } = await waitingOnWrite(env, kit);

    await advance(timers, LONGEST_RUN_MS, HOUR_MS);

    expect(await env.getRun(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect((await env.http('GET', `/v1/approvals/${approval.id}`)).json.approval.status).toBe('withdrawn');
    expect(env.ofType(run.id, 'tool.permission.cancelled')).toEqual([expect.objectContaining({ approvalId: approval.id, reason: 'withdrawn' })]);
  });
});
