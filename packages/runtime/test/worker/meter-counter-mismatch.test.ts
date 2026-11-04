import { describe, expect, it } from 'vitest';
import type { Capabilities, MomongaResponseExtension, StreamEvent } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { PRIMARY_TARGET, fakeCounterOf } from './fake-gateway.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv, modelKey } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const SECONDARY = 'secondary';
const RESTARTED_PRIMARY = fakeCounterOf('primary after the gateway restarted with other settings');
const RESTARTED_SECONDARY = fakeCounterOf('secondary after the gateway restarted with other settings');

const exactTarget = (): Capabilities => capabilitiesFor(8192, { maxOutputTokens: 1024 });

const answeredWith = (step: ScriptStep, momonga: MomongaResponseExtension): ScriptStep => ({
  ...step,
  events: step.events.map((event): StreamEvent => (event.type === 'response.completed' ? { ...event, response: { ...event.response, momonga } } : event)),
});

const byPrimary = (counter: string): MomongaResponseExtension => ({ alias: 'fm', target: PRIMARY_TARGET, counter, attempts: 1, usageSource: 'reported' });

const bySecondary = (counter: string): MomongaResponseExtension => ({
  alias: 'fm',
  target: SECONDARY,
  counter,
  attempts: 2,
  fallbackFrom: [PRIMARY_TARGET],
  fallbackCauses: [{ target: PRIMARY_TARGET, code: 'upstream_error', message: 'primary is down' }],
  usageSource: 'reported',
});

const sessionWithReports = async (answer: (counter: string) => MomongaResponseExtension, listed: string): Promise<Env> => {
  const env = await makeEnv({ capabilities: exactTarget() });
  env.gateway.targetsByAlias[env.session.modelAlias] = [PRIMARY_TARGET, SECONDARY];
  env.gateway.script.push(answeredWith(textStep('Earlier.'), answer(fakeCounterOf(listed))));
  const earlier = env.enqueue('An earlier task of the session');
  await env.runOnce(env.worker());
  expect(env.run(earlier.id).status).toBe('COMPLETED');
  expect(env.ofType(earlier.id, 'meter.observed')).toHaveLength(1);
  return env;
};

describe.each([
  ['the alias meter', PRIMARY_TARGET, RESTARTED_PRIMARY, byPrimary, false],
  ['a fallback meter', SECONDARY, RESTARTED_SECONDARY, bySecondary, true],
] as const)('a response whose counter differs from the counter of %s', (_label, target, restarted, answer, fallback) => {
  it('is not observed, ends the claim with a gateway failure that uses up an attempt, and the next claim resends the recorded body and folds afresh', async () => {
    const env = await sessionWithReports(answer, target);
    env.gateway.script.push(answeredWith(textStep('Answered by a restarted gateway.'), answer(restarted)));
    const run = env.enqueue('The task the restarted gateway answers');

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');

    const released = env.run(run.id);
    expect(released).toMatchObject({ status: 'QUEUED', attempts: 1, leaseOwner: null });
    expect(env.ofType(run.id, 'meter.observed')).toEqual([]);
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'RUNNING', to: 'QUEUED' });

    env.gateway.countersByTarget.set(target, restarted);
    env.clock.set(Math.max(env.clock.now(), released.availableAt));
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [first, second] = env.gateway.streams.slice(-2);
    expect(second?.idempotencyKey).toBe(modelKey(run.id, 1, 1));
    expect(first?.idempotencyKey).toBe(second?.idempotencyKey);
    expect(second?.body).toEqual(first?.body);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'meter.observed')).toMatchObject([{ target, counter: restarted, fallback, known: 0 }]);
  });

  it('gives it no truncation verdict: a report far below the count does not fail the run', async () => {
    const env = await sessionWithReports(answer, target);
    env.gateway.script.push(answeredWith(textStep('Answered by a restarted gateway.', { usage: usageOf(10, 5) }), answer(restarted)));
    const run = env.enqueue(`The task the restarted gateway answers ${'padding '.repeat(400)}`);

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(env.ofType(run.id, 'meter.observed')).toEqual([]);
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);
  });
});
