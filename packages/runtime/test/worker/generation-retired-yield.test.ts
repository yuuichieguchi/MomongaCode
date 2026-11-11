import { describe, expect, it } from 'vitest';
import { fixedRolePort } from '@momonga/foundation';
import { GatewayRequestError } from '@momonga/runtime';
import { mutableRole } from '../shared/mutable-role.ts';

import { makeEnv } from './harness.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { callsStep, gated, textStep } from './scripts.ts';

type ErrorFields = ConstructorParameters<typeof GatewayRequestError>[0];

const thrown = (fields: ErrorFields): ScriptStep => ({ events: [], error: new GatewayRequestError(fields) });

const RETIRED: ErrorFields = { status: 503, type: 'server_error', code: 'generation_retired', message: 'this generation is retiring and takes no new call' };

const NEVER_REACHED: ErrorFields = { status: 0, type: 'transport', code: 'gateway_unavailable', message: 'connect ECONNREFUSED', provenNotSent: true };

const leaseGeneration = (env: Awaited<ReturnType<typeof makeEnv>>, runId: string): unknown => env.raw().prepare('SELECT lease_generation FROM runs WHERE id = ?').get(runId)?.['lease_generation'];

describe('the claim gate by role (17.1, 20.2)', () => {
  it.each(['starting', 'retiring'] as const)('a %s worker claims nothing: the queued run stays queued', async (role) => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('never sent'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker('w1', { role: fixedRolePort(role) }))).toBe('idle');

    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', attempts: 0, leaseOwner: null });
    expect(env.gateway.streams).toEqual([]);
  });

  it('refreshes the role before every claim, so the first claim after a promotion waits for no tick', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue('Work');
    const role = mutableRole('starting');
    const worker = env.worker('w1', { role: role.port });

    expect(await env.runOnce(worker)).toBe('idle');
    role.set('serving');
    expect(await env.runOnce(worker)).toBe('yielded');

    expect(role.refreshes()).toBe(2);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});

describe('a retire-yield (20.3, 18.1.3)', () => {
  it('yields the run untouched when the gateway refuses the model call with generation_retired', async () => {
    const env = await makeEnv();
    env.gateway.script.push(thrown(RETIRED), textStep('Done on the serving generation.'));
    const run = env.enqueue('Work');
    const role = mutableRole('serving');

    expect(await env.runOnce(env.worker('w1', { role: role.port }))).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', attempts: 0, failedAttempts: 0, leaseOwner: null });
    expect(leaseGeneration(env, run.id)).toBeNull();
    expect(env.ofType(run.id, 'attempt.failed')).toEqual([]);
    expect(env.ofType(run.id, 'notice')).toEqual([]);
    expect(env.gateway.streams).toHaveLength(1);
    expect(role.refreshes()).toBe(2);

    expect(await env.runOnce(env.worker('w2'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('yields the run untouched when the gateway cannot be reached and the role, read fresh, is retiring', async () => {
    const env = await makeEnv();
    env.gateway.script.push(thrown(NEVER_REACHED), textStep('never sent here'));
    const run = env.enqueue('Work');
    const role = mutableRole('serving');
    const worker = env.worker('w1', { role: { current: role.port.current, refresh: async () => (role.refreshes() === 0 ? role.port.refresh() : (role.set('retiring'), role.port.refresh())) } });

    expect(await env.runOnce(worker)).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', attempts: 0, failedAttempts: 0 });
    expect(env.ofType(run.id, 'attempt.failed')).toEqual([]);
  });

  it('keeps the ordinary requeue, with its attempt.failed record, when the gateway cannot be reached while serving', async () => {
    const env = await makeEnv();
    env.gateway.script.push(thrown(NEVER_REACHED), textStep('Recovered.'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker('w1'))).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
    expect(env.ofType(run.id, 'attempt.failed')).toHaveLength(1);
  });
});

describe('a step in flight when the role becomes retiring (17.1, 20.31)', () => {
  it('finishes the model call it is in, then yields the run untouched at the next boundary, before the tool runs; the serving worker runs the tool once and completes', async () => {
    const env = await makeEnv();
    const blocked = gated(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), 1);
    env.gateway.script.push(blocked, textStep('Done.'));
    const run = env.enqueue('Work');
    const role = mutableRole('serving');
    const running = env.runOnce(env.worker('w1', { role: role.port }));
    await env.settled(blocked.gate.reached.promise, 'the stream to start');

    role.set('retiring');
    blocked.gate.release.resolve();
    expect(await env.settled(running, 'the retiring worker to finish its step')).toBe('yielded');

    expect(env.ofType(run.id, 'model.responded')).toHaveLength(1);
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.gateway.streams[0]?.signal.aborted).toBe(false);
    expect(env.ofType(run.id, 'tool.started')).toEqual([]);
    expect(env.ofType(run.id, 'attempt.failed')).toEqual([]);
    expect(env.ofType(run.id, 'notice')).toEqual([]);
    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', attempts: 0, failedAttempts: 0, leaseOwner: null });
    expect(leaseGeneration(env, run.id)).toBeNull();

    expect(await env.runOnce(env.worker('w2'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.started')).toHaveLength(1);
    expect(env.ofType(run.id, 'model.responded')).toHaveLength(2);
  });
});
