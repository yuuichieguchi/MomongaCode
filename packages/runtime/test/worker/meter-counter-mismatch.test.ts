import { describe, expect, it } from 'vitest';
import type { Capabilities, MomongaResponseExtension, RunEventPayload, StreamEvent } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { PRIMARY_TARGET, fakeCounterOf } from './fake-gateway.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv, modelKey } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';
import { GatewayRequestError, LeaseLostError } from '@momonga/runtime';
import { recordingStore } from './within-turn-support.ts';

const SECONDARY = 'secondary';
const BEFORE_RESTART_PRIMARY = fakeCounterOf('primary before the gateway restarted with other settings');
const BEFORE_RESTART_SECONDARY = fakeCounterOf('secondary before the gateway restarted with other settings');
const REJECTED_USAGE = usageOf(1234, 56);

const exactTarget = (): Capabilities => capabilitiesFor(8192, { maxOutputTokens: 1024 });

const answeredWith = (step: ScriptStep, momonga: MomongaResponseExtension): ScriptStep => ({
  ...step,
  events: step.events.map((event): StreamEvent => (event.type === 'response.completed' ? { ...event, response: { ...event.response, momonga } } : event)),
});

const byPrimary = (counter: string): MomongaResponseExtension => ({ model: 'fm', target: PRIMARY_TARGET, counter, attempts: 1, usageSource: 'reported' });

const bySecondary = (counter: string): MomongaResponseExtension => ({
  model: 'fm',
  target: SECONDARY,
  counter,
  attempts: 2,
  fallbackFrom: [PRIMARY_TARGET],
  fallbackCauses: [{ target: PRIMARY_TARGET, code: 'upstream_error', message: 'primary is down' }],
  usageSource: 'reported',
});

const sessionWithReports = async (answer: (counter: string) => MomongaResponseExtension, listed: string): Promise<Env> => {
  const env = await makeEnv({ capabilities: exactTarget() });
  env.gateway.chainsByModel[env.session.model] = [PRIMARY_TARGET, SECONDARY];
  env.gateway.script.push(answeredWith(textStep('Earlier.'), answer(fakeCounterOf(listed))));
  const earlier = env.enqueue('An earlier task of the session');
  await env.runOnce(env.worker());
  expect(env.run(earlier.id).status).toBe('COMPLETED');
  return env;
};

const latestResponseIdOf = (env: Env): string => `resp_generation_${[...env.gateway.generations.values()].reduce((sum, count) => sum + count, 0)}`;

const CASES = [
  ['the model meter', PRIMARY_TARGET, BEFORE_RESTART_PRIMARY, byPrimary, false],
  ['a fallback meter', SECONDARY, BEFORE_RESTART_SECONDARY, bySecondary, true],
] as const;

describe.each(CASES)('an answer replayed after a counter change, for %s', (_label, target, stale, answer, fallback) => {
  it('is rejected with model.rejected and its charge in one append, and the next claim resends under the next attempt to the new target and completes', async () => {
    const env = await sessionWithReports(answer, target);
    const streamsBefore = env.gateway.streams.length;
    env.gateway.script.push(answeredWith(textStep('Stored before the restart.', { usage: REJECTED_USAGE }), answer(stale)), answeredWith(textStep('Answered by the new target.'), answer(fakeCounterOf(target))));
    const { store, appends } = recordingStore(env);
    const run = env.enqueue('The task the restarted gateway answers');

    expect(await env.runOnce(env.worker('worker-1', { store }))).toBe('yielded');

    const released = env.run(run.id);
    expect(released).toMatchObject({ status: 'QUEUED', attempts: 1, leaseOwner: null });
    expect(env.ofType(run.id, 'meter.observed')).toEqual([]);
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);
    const rejectedId = latestResponseIdOf(env);
    const rejectedEvent = { type: 'model.rejected', step: 1, attempt: 1, reason: 'counter_mismatch', counter: stale, meterCounter: fakeCounterOf(target) };
    const chargeEvent = { type: 'usage.charged', purpose: 'rejected_answer', inputTokens: 1234, outputTokens: 56, totalTokens: 1290, responseId: rejectedId };
    expect(env.ofType(run.id, 'model.rejected')).toMatchObject([rejectedEvent]);
    expect(env.ofType(run.id, 'usage.charged')).toMatchObject([chargeEvent]);
    const together = appends.filter((payloads) => payloads.some((payload) => payload.type === 'model.rejected'));
    expect(together).toHaveLength(1);
    expect(together[0]).toEqual(expect.arrayContaining([expect.objectContaining(rejectedEvent), expect.objectContaining(chargeEvent)]));

    env.clock.set(Math.max(env.clock.now(), released.availableAt));
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [first, second] = env.gateway.streams.slice(streamsBefore);
    expect(env.gateway.streams).toHaveLength(streamsBefore + 2);
    expect(first?.idempotencyKey).toBe(modelKey(run.id, 1, 1));
    expect(second?.idempotencyKey).toBe(modelKey(run.id, 1, 2));
    expect(second?.deduplicated).toBe(false);
    expect(env.gateway.generations.get(modelKey(run.id, 1, 2))).toBe(1);
    expect(second?.body).toEqual(first?.body);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'model.responded')).toEqual([expect.objectContaining({ step: 1, attempt: 2 })]);
    expect(env.ofType(run.id, 'meter.observed')).toMatchObject([{ target, counter: fakeCounterOf(target), fallback }]);
  });

  it('gives it no truncation verdict: a report far below the count does not fail the run', async () => {
    const env = await sessionWithReports(answer, target);
    env.gateway.script.push(answeredWith(textStep('Stored before the restart.', { usage: usageOf(10, 5) }), answer(stale)));
    const run = env.enqueue(`The task the restarted gateway answers ${'padding '.repeat(400)}`);

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(env.ofType(run.id, 'meter.observed')).toEqual([]);
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);
  });
});

describe('the attempt of a resend', () => {
  it('stays the same after a claim that received no answer, so the key does not change', async () => {
    const env = await makeEnv({ capabilities: exactTarget() });
    env.gateway.script.push(
      { events: [], error: new GatewayRequestError({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway connection was lost', provenNotSent: false }) },
      textStep('Recovered.'),
    );
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
    env.clock.set(Math.max(env.clock.now(), env.run(run.id).availableAt));
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.map((stream) => stream.idempotencyKey)).toEqual([modelKey(run.id, 1, 1), modelKey(run.id, 1, 1)]);
    expect(env.ofType(run.id, 'model.rejected')).toEqual([]);
  });
});

describe('the charge of a rejected answer', () => {
  const spendOfRun = (env: Env, runId: string) => {
    const accepted = env.ofType(runId, 'model.responded').reduce((sum, event) => sum + event.response.usage.total_tokens, 0);
    return { accepted, fold: env.fold(runId).usage.totalTokens, store: env.run(runId).usage.totalTokens };
  };

  it('counts the rejected answer once in the fold usage and the store usage', async () => {
    const env = await makeEnv({ capabilities: exactTarget() });
    env.gateway.script.push(answeredWith(textStep('Stored before the restart.', { usage: REJECTED_USAGE }), byPrimary(BEFORE_RESTART_PRIMARY)), textStep('Answered by the new target.'));
    const run = env.enqueue('Work');

    await env.runOnce(env.worker('worker-1'));
    env.clock.set(Math.max(env.clock.now(), env.run(run.id).availableAt));
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const spend = spendOfRun(env, run.id);
    expect(env.ofType(run.id, 'usage.charged').filter((event) => event.purpose === 'rejected_answer')).toHaveLength(1);
    expect(spend.fold).toBe(spend.accepted + 1290);
    expect(spend.store).toBe(spend.accepted + 1290);
  });

  it('counts it once when the claim stops between the decision and the append: the next claim decides again on the replayed answer', async () => {
    const env = await makeEnv({ capabilities: exactTarget() });
    env.gateway.script.push(answeredWith(textStep('Stored before the restart.', { usage: REJECTED_USAGE }), byPrimary(BEFORE_RESTART_PRIMARY)), textStep('Answered by the new target.'));
    let stopped = false;
    const { store } = recordingStore(env, (payloads: readonly RunEventPayload[]) => {
      if (!stopped && payloads.some((payload) => payload.type === 'model.rejected')) {
        stopped = true;
        throw new LeaseLostError();
      }
    });
    const run = env.enqueue('Work');

    await env.runOnce(env.worker('worker-1', { store }));
    expect(stopped).toBe(true);
    expect(env.ofType(run.id, 'model.rejected')).toEqual([]);
    for (let claim = 2; claim <= 3 && env.run(run.id).status !== 'COMPLETED'; claim += 1) {
      env.clock.set(Math.max(env.clock.now(), env.run(run.id).availableAt) + 60_000);
      await env.runOnce(env.worker(`worker-${claim}`));
    }

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.map((stream) => stream.idempotencyKey)).toEqual([modelKey(run.id, 1, 1), modelKey(run.id, 1, 1), modelKey(run.id, 1, 2)]);
    expect(env.gateway.streams[1]?.deduplicated).toBe(true);
    expect(env.ofType(run.id, 'model.rejected')).toHaveLength(1);
    const spend = spendOfRun(env, run.id);
    expect(spend.fold).toBe(spend.accepted + 1290);
    expect(spend.store).toBe(spend.accepted + 1290);
  });
});

const withoutCounter = (step: ScriptStep): ScriptStep => ({
  ...step,
  events: step.events.map((event): StreamEvent =>
    event.type === 'response.completed'
      ? { ...event, response: { ...event.response, momonga: { ...byPrimary(fakeCounterOf(PRIMARY_TARGET)), counter: undefined } as unknown as MomongaResponseExtension } }
      : event,
  ),
});

const withoutUsage = (step: ScriptStep): ScriptStep => ({
  ...step,
  events: step.events.map((event): StreamEvent =>
    event.type === 'response.completed' ? ({ ...event, response: { ...event.response, usage: null, momonga: byPrimary(fakeCounterOf(PRIMARY_TARGET)) } } as unknown as StreamEvent) : event,
  ),
});

const withoutTarget = (step: ScriptStep): ScriptStep => ({
  ...step,
  events: step.events.map((event): StreamEvent => {
    if (event.type !== 'response.completed') return event;
    const { target: _target, ...untargeted } = byPrimary(fakeCounterOf(PRIMARY_TARGET));
    return { ...event, response: { ...event.response, momonga: untargeted as unknown as MomongaResponseExtension } };
  }),
});

describe.each([
  ['without a counter', 'missing_counter', withoutCounter, { meterCounter: fakeCounterOf(PRIMARY_TARGET) }, true],
  ['without usage', 'missing_usage', withoutUsage, {}, false],
  ['without a target', 'missing_target', withoutTarget, { counter: fakeCounterOf(PRIMARY_TARGET) }, true],
] as const)('a complete answer %s stored under the key of the call', (_label, reason, broken, known, charged) => {
  it('is rejected with model.rejected, and the next claim resends under the next attempt and completes instead of looping to the attempt limit', async () => {
    const env = await makeEnv({ capabilities: exactTarget(), maxAttempts: 3, maxTotalAttempts: 3 });
    env.gateway.script.push(broken(textStep('A broken answer.', { usage: REJECTED_USAGE })), textStep('A whole answer.'));
    const { store, appends } = recordingStore(env);
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker('worker-1', { store }))).toBe('yielded');

    const released = env.run(run.id);
    expect(released).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);
    expect(env.ofType(run.id, 'meter.observed')).toEqual([]);
    expect(env.ofType(run.id, 'model.rejected')).toMatchObject([{ type: 'model.rejected', step: 1, attempt: 1, reason, ...known }]);
    const rejecting = appends.filter((payloads) => payloads.some((payload) => payload.type === 'model.rejected'));
    expect(rejecting).toHaveLength(1);
    const charges = (rejecting[0] ?? []).filter((payload) => payload.type === 'usage.charged');
    if (charged) expect(charges).toMatchObject([{ type: 'usage.charged', purpose: 'rejected_answer', inputTokens: 1234, outputTokens: 56, totalTokens: 1290 }]);
    else expect(charges).toEqual([]);
    expect(env.ofType(run.id, 'usage.charged')).toHaveLength(charged ? 1 : 0);

    env.clock.set(Math.max(env.clock.now(), released.availableAt));
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.map((stream) => stream.idempotencyKey)).toEqual([modelKey(run.id, 1, 1), modelKey(run.id, 1, 2)]);
    expect(env.gateway.streams[1]?.body).toEqual(env.gateway.streams[0]?.body);
    expect(env.ofType(run.id, 'model.responded')).toEqual([expect.objectContaining({ step: 1, attempt: 2 })]);
  });
});

