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
    unsandboxed.timers?.advance(60 * 60_000);
    expect((await unsandboxed.http('GET', '/v1/health')).json.sandbox).toBe('none');
  });
});
