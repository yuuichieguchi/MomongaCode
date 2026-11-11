import { describe, expect, it } from 'vitest';
import type { Capabilities, StreamEvent } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { fakeCounterOf, inputTokensOf } from './fake-gateway.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const WINDOW = 8192;
const FIRST_TASK = `Echo something ${'padding '.repeat(500)}`;
const SECOND_TASK = `Echo something else ${'filling '.repeat(1000)}`;

const exactTarget = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024 });

const answeredFirstBy = (step: ScriptStep, target: string): ScriptStep => ({
  ...step,
  events: step.events.map(
    (event): StreamEvent =>
      event.type === 'response.completed'
        ? { ...event, response: { ...event.response, momonga: { model: 'fm', target, counter: fakeCounterOf(target), attempts: 1, usageSource: 'reported' } } }
        : event,
  ),
});

const measuredAcrossRuns = async (): Promise<[number, number]> => {
  const measuring = await makeEnv({ capabilities: exactTarget() });
  measuring.gateway.script.push(textStep('Done.'), textStep('Again.'));
  await measuring.enqueue(FIRST_TASK);
  await measuring.runOnce(measuring.worker());
  await measuring.enqueue(SECOND_TASK);
  await measuring.runOnce(measuring.worker());
  return measuring.gateway.streams.map((stream) => inputTokensOf(stream.body)) as [number, number];
};

describe('the model meter after the model moved to another first target', () => {
  it('does not split the first request of a run answered by t2 on the report of t1 from an earlier run', async () => {
    const [firstCount, secondCount] = await measuredAcrossRuns();
    expect(secondCount - firstCount).toBeGreaterThanOrEqual(firstCount);
    const env = await makeEnv({ capabilities: exactTarget() });
    env.gateway.script.push(
      answeredFirstBy(textStep('Done.', { usage: usageOf(2 * firstCount, 5) }), 't1'),
      answeredFirstBy(textStep('Again.', { usage: usageOf(secondCount, 5) }), 't2'),
    );
    env.gateway.chainsByModel[env.session.model] = ['t1'];
    const one = await env.enqueue(FIRST_TASK);
    await env.runOnce(env.worker());
    env.gateway.chainsByModel[env.session.model] = ['t2'];
    const two = await env.enqueue(SECOND_TASK);
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(one.id).status).toBe('COMPLETED');
    expect(fakeCounterOf('t1')).not.toBe(fakeCounterOf('t2'));
    expect(env.ofType(one.id, 'meter.observed')).toMatchObject([{ target: 't1', counter: fakeCounterOf('t1'), fallback: false, counted: firstCount, reported: 2 * firstCount }]);
    expect({ status: env.run(two.id).status, error: env.run(two.id).error?.code }).toEqual({ status: 'COMPLETED', error: undefined });
    expect(env.ofType(two.id, 'meter.observed')[0]).toMatchObject({ target: 't2', counter: fakeCounterOf('t2'), fallback: false, known: 0, counted: secondCount });
  });
});
