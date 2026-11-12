import { describe, expect, it } from 'vitest';
import { SERVICE_PID, SERVICE_VERSION, STARTED_AT, expectSchema, startService } from './helpers.ts';

describe('health (fake timers)', () => {
  it('reports status, version, apiVersion, pid, startedAt, state and sandbox, and validates against RUN_API_SCHEMAS.Health', async () => {
    const env = await startService({ fakeTimers: true });
    const response = await env.http('GET', '/v1/health');
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      status: 'ok',
      version: SERVICE_VERSION,
      apiVersion: 1,
      pid: SERVICE_PID,
      startedAt: STARTED_AT,
      state: 'running',
      role: 'serving',
      steps: 0,
      jobs: 0,
      interrupts: [],
      sandbox: 'seatbelt',
    });
    expectSchema('Health', response.json);
  });

  it('state is running before beginDraining and draining after', async () => {
    const env = await startService({ fakeTimers: true });
    const before = await env.http('GET', '/v1/health');
    expect(before.json.state).toBe('running');
    env.service.beginDraining();
    const after = await env.http('GET', '/v1/health');
    expect(after.json).toEqual({ ...before.json, state: 'draining' });
    expectSchema('Health', after.json);
  });

  it('sandbox is the sandboxKind option', async () => {
    const unsandboxed = await startService({ fakeTimers: true, sandboxKind: 'none' });
    const response = await unsandboxed.http('GET', '/v1/health');
    expect(response.json.sandbox).toBe('none');
    expectSchema('Health', response.json);
    await unsandboxed.timers?.advanceAsync(60 * 60_000);
    expect((await unsandboxed.http('GET', '/v1/health')).json.sandbox).toBe('none');
  });

  it('names the runs in flight and the live jobs it would interrupt, the first five, each command cut to its first 40 characters (20.75)', async () => {
    const longCommand = `npm run build -- --watch --mode development --verbose`;
    const env = await startService({
      fakeTimers: true,
      work: {
        runs: () => ['run-a', 'run-b'],
        jobs: () => [
          { id: 'job-1', command: 'sleep 100' },
          { id: 'job-2', command: longCommand },
          { id: 'job-3', command: 'make' },
          { id: 'job-4', command: 'make test' },
        ],
      },
    });
    const response = await env.http('GET', '/v1/health');
    expect(response.json.steps).toBe(2);
    expect(response.json.jobs).toBe(4);
    expect(response.json.interrupts).toEqual([
      { kind: 'run', id: 'run-a' },
      { kind: 'run', id: 'run-b' },
      { kind: 'job', id: 'job-1', command: 'sleep 100' },
      { kind: 'job', id: 'job-2', command: longCommand.slice(0, 40) },
      { kind: 'job', id: 'job-3', command: 'make' },
    ]);
    expectSchema('Health', response.json);
  });
});
