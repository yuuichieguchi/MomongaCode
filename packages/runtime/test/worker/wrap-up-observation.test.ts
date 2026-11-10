import { describe, expect, it, vi } from 'vitest';
import type { UsageObservation } from '@momonga/context';
import { usageOf } from '@momonga/testkit';
import { fakeCounterOf } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import { bigStep, withinTurnWorker } from './within-turn-support.ts';

const observations = vi.hoisted(() => [] as UsageObservation[]);

vi.mock('@momonga/context', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/context')>();
  return {
    ...original,
    createTokenMeter: (options: Parameters<typeof original.createTokenMeter>[0]) => {
      const meter = original.createTokenMeter(options);
      return {
        ...meter,
        observe: (observation: UsageObservation) => {
          observations.push(observation);
          return meter.observe(observation);
        },
      };
    },
  };
});

describe('usage observation by the token meter', () => {
  it('observes the usage of an ordinary reply', async () => {
    observations.length = 0;
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.gateway.script.push(textStep('Done.', { usage: usageOf(321, 5) }));
    env.enqueue('Say done');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(observations.map((observation) => observation.inputTokens)).toEqual([321]);
  });

  it('observes the context input tokens the gateway reports for a continued turn instead of the billed sum', async () => {
    observations.length = 0;
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    const step = textStep('Done.', { usage: usageOf(321, 5) });
    const events = step.events.map((event) =>
      event.type === 'response.completed'
        ? { ...event, response: { ...event.response, momonga: { model: 'default', target: 'primary', counter: fakeCounterOf('primary'), attempts: 1, usageSource: 'reported' as const, contextInputTokens: 55 } } }
        : event,
    );
    env.gateway.script.push({ ...step, events });
    env.enqueue('Say done');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(observations.map((observation) => observation.inputTokens)).toEqual([55]);
  });

  it('does not observe the usage of the reply to a context wrap-up request', async () => {
    observations.length = 0;
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.gateway.script.push(bigStep('k0', { letter: 'a', size: 0, pad: 'p'.repeat(7400) }), textStep('Here is what I did.', { usage: usageOf(999, 5) }));
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker('d'.repeat(4000))));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.streams).toHaveLength(2);
    expect(env.gateway.streams[1]?.body.tool_choice).toBe('none');
    expect(observations.map((observation) => observation.inputTokens)).not.toContain(999);
  });
});
