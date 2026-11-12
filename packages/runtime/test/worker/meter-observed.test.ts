import { describe, expect, it } from 'vitest';
import { TOKEN_SETTINGS_OFF } from './fake-settings.ts';
import { ESTIMATED_ERROR_SHAPE, errorBoundOfShape, marginFloorFor } from '@momonga/protocol';
import type { Capabilities, RunEventPayload, StreamEvent } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { PRIMARY_TARGET, fakeCounterOf, inputTokensOf } from './fake-gateway.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { bigStep, recordingStore, withinTurnWorker } from './within-turn-support.ts';

const WINDOW = 8192;
const FLOOR = marginFloorFor(WINDOW);
const LARGE_TASK = `Echo something ${'padding '.repeat(2200)}`;
const TASK = `Echo something ${'padding '.repeat(500)}`;

const exactTarget = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024 });
const estimatedTarget = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
const calibratedTarget = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024, tokenCounting: 'calibrated', tokenErrorRatio: 0.25 });
const CALIBRATED_SHAPE = { ratio: 0.25, minimum: 1 };

const calibrated = (env: Env): Env => {
  env.gateway.countMethod = 'calibrated';
  env.gateway.countShape = CALIBRATED_SHAPE;
  return env;
};

const estimated = (env: Env): Env => {
  env.gateway.countMethod = 'estimated';
  return env;
};

const measuredInputs = async (capabilities: Capabilities, prepare: (env: Env) => Env, script: () => ScriptStep[], task: string): Promise<number[]> => {
  const env = prepare(await makeEnv({ capabilities }));
  env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
  env.gateway.script.push(...script());
  await env.enqueue(task);
  await env.runOnce(env.worker());
  return env.gateway.streams.map((stream) => inputTokensOf(stream.body));
};

const answeredBy = (step: ScriptStep, target: string): ScriptStep => ({
  ...step,
  events: step.events.map(
    (event): StreamEvent =>
      event.type === 'response.completed'
        ? {
            ...event,
            response: {
              ...event.response,
              momonga: {
                model: 'fm',
                target,
                counter: fakeCounterOf(target),
                attempts: 2,
                fallbackFrom: ['primary'],
                fallbackCauses: [{ target: 'primary', code: 'upstream_error', message: 'primary is down' }],
                usageSource: 'reported',
              },
            },
          }
        : event,
  ),
});

describe('a calibrated count is checked against its calibrated shape', () => {
  const oneStep = (usage?: number) => () => [textStep('Done.', usage === undefined ? {} : { usage: usageOf(usage, 5) })];

  it('completes when the server reports 85 percent of a calibrated count, more than the margin floor below it but within the shape', async () => {
    const [estimate] = (await measuredInputs(calibratedTarget(), calibrated, oneStep(), LARGE_TASK)) as [number];
    const reported = Math.floor(estimate * 0.85);
    expect(estimate - reported).toBeGreaterThan(FLOOR);
    const env = calibrated(await makeEnv({ capabilities: calibratedTarget() }));
    env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
    env.gateway.script.push(...oneStep(reported)());
    const run = await env.enqueue(LARGE_TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('allows exactly the margin floor plus the calibrated shape of the count and stops one token below', async () => {
    const [estimate] = (await measuredInputs(calibratedTarget(), calibrated, oneStep(), LARGE_TASK)) as [number];
    const allowed = FLOOR + errorBoundOfShape(CALIBRATED_SHAPE, estimate);
    const runAt = async (reported: number) => {
      const env = calibrated(await makeEnv({ capabilities: calibratedTarget() }));
      env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
      env.gateway.script.push(...oneStep(reported)());
      const run = await env.enqueue(LARGE_TASK);
      await env.runOnce(env.worker());
      return env.run(run.id);
    };
    expect((await runAt(estimate - allowed)).status).toBe('COMPLETED');
    expect(await runAt(estimate - allowed - 1)).toMatchObject({ status: 'FAILED', error: { code: 'input_truncated' } });
  });
});

describe('the over side of a step built on a report below the count', () => {
  const script = (usage1: 'auto' | number, usage2: 'auto' | number) => () => [
    callsStep([{ callId: 'call_o_1', name: 'Echo', args: { value: 'a'.repeat(400) } }], usage1 === 'auto' ? 'auto' : usageOf(usage1, 5)),
    textStep('Done.', { usage: usage2 === 'auto' ? 'auto' : usageOf(usage2, 5) }),
  ];

  it('allows the margin floor, the known over-count O and the shape of the new part, and stops one token below', async () => {
    const [first, second] = (await measuredInputs(estimatedTarget(), estimated, script('auto', 'auto'), LARGE_TASK)) as [number, number];
    const firstReport = Math.floor(first * 0.85);
    const overCount = first - firstReport;
    const allowed = FLOOR + overCount + errorBoundOfShape(ESTIMATED_ERROR_SHAPE, second - first);
    const runAt = async (secondReport: number) => {
      const env = estimated(await makeEnv({ capabilities: estimatedTarget() }));
      env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
      env.gateway.script.push(...script(firstReport, secondReport)());
      const run = await env.enqueue(LARGE_TASK);
      await env.runOnce(env.worker());
      return { run: env.run(run.id), observed: env.ofType(run.id, 'meter.observed') };
    };

    const at = await runAt(second - allowed);
    expect(at.run.status).toBe('COMPLETED');
    expect((await runAt(second - allowed - 1)).run).toMatchObject({ status: 'FAILED', error: { code: 'input_truncated' } });
    expect(at.observed.map(({ known, uncounted, counted, kept }) => ({ known, uncounted, counted, kept }))).toEqual([
      { known: 0, uncounted: first, counted: first, kept: first },
      { known: first, uncounted: second - first, counted: second, kept: second },
    ]);
  });
});

describe('an exact target', () => {
  it('stops when the server reports 85 percent of an exact count', async () => {
    const [estimate] = (await measuredInputs(exactTarget(), (env) => env, () => [textStep('Done.')], LARGE_TASK)) as [number];
    const env = await makeEnv({ capabilities: exactTarget() });
    env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
    env.gateway.script.push(textStep('Done.', { usage: usageOf(Math.floor(estimate * 0.85), 5) }));
    const run = await env.enqueue(LARGE_TASK);

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'input_truncated' } });
  });
});

describe('meter.observed is journaled with the response', () => {
  it('records the report in the same append as model.responded, with the fields of the count', async () => {
    const env = await makeEnv({ capabilities: exactTarget() });
    env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
    env.gateway.script.push(textStep('Done.', { usage: usageOf(100_000, 5) }));
    const { store, appends } = recordingStore(env);
    const run = await env.enqueue(TASK);

    await env.runOnce(env.worker('worker-1', { store }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const body = env.gateway.streams[0]?.body;
    if (body === undefined) throw new Error('the run made no model call');
    const counted = inputTokensOf(body);
    const together = appends.filter((payloads) => payloads.some((payload) => payload.type === 'model.responded'));
    expect(together).toHaveLength(1);
    const observed = together[0]?.find((payload) => payload.type === 'meter.observed');
    expect(observed).toMatchObject({
      type: 'meter.observed',
      itemCount: (body.input as unknown[]).length,
      counted,
      reported: 100_000,
      kept: 100_000,
      known: 0,
      uncounted: counted,
      miss: 100_000 - counted,
      target: PRIMARY_TARGET,
      fallback: false,
      contextWindow: WINDOW,
      tokenCounting: 'exact',
    });
    expect(observed).not.toHaveProperty('tokenErrorRatio');
    expect(observed).not.toHaveProperty('shape');
    expect(typeof (observed as { inputDigest?: unknown } | undefined)?.inputDigest).toBe('string');
    expect(env.ofType(run.id, 'meter.observed')).toHaveLength(1);
  });

  it('records nothing for a summary request', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
    env.gateway.script.push(bigStep('k0', { letter: 'a', size: 0, pad: 'p'.repeat(7400) }), textStep('Here is what I did.'));
    const { store, appends } = recordingStore(env);
    const run = await env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', { ...withinTurnWorker('d'.repeat(4000)), store }));

    expect(env.gateway.streams[1]?.body.tool_choice).toBe('none');
    const responded = appends.filter((payloads) => payloads.some((payload) => payload.type === 'model.responded'));
    expect(responded).toHaveLength(2);
    const stepOf = (payloads: readonly RunEventPayload[]): number | undefined =>
      payloads.flatMap((payload) => (payload.type === 'model.responded' ? [payload.step] : []))[0];
    const summary = responded.find((payloads) => stepOf(payloads) === 2);
    const work = responded.find((payloads) => stepOf(payloads) === 1);
    expect(summary?.some((payload) => payload.type === 'meter.observed')).toBe(false);
    expect(work?.some((payload) => payload.type === 'meter.observed')).toBe(true);
    expect(env.ofType(run.id, 'meter.observed')).toHaveLength(1);
  });
});

describe('the meter of a claim is folded from the session journal', () => {
  const measuredAcrossRuns = async (): Promise<[number, number]> => {
    const measuring = await makeEnv({ capabilities: exactTarget() });
    measuring.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
    measuring.gateway.script.push(textStep('Done.'), textStep('Again.'));
    await measuring.enqueue(TASK);
    await measuring.runOnce(measuring.worker());
    await measuring.enqueue('Now the second task');
    await measuring.runOnce(measuring.worker());
    return measuring.gateway.streams.map((stream) => inputTokensOf(stream.body)) as [number, number];
  };

  it('splits the first request of the next run against the report of the previous run', async () => {
    const [firstCount, secondCount] = await measuredAcrossRuns();
    const env = await makeEnv({ capabilities: exactTarget() });
    env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
    env.gateway.script.push(textStep('Done.', { usage: usageOf(firstCount - 50, 5) }), textStep('Again.'));
    const one = await env.enqueue(TASK);
    await env.runOnce(env.worker());
    const two = await env.enqueue('Now the second task');
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(one.id).status).toBe('COMPLETED');
    expect(env.run(two.id).status).toBe('COMPLETED');
    expect(env.ofType(two.id, 'meter.observed')).toMatchObject([{ target: PRIMARY_TARGET, fallback: false, known: firstCount, uncounted: secondCount - firstCount, counted: secondCount }]);
  });

  it('keeps the reports of a fallback target out of the model meter and gives them to that target meter', async () => {
    const [firstCount, secondCount] = await measuredAcrossRuns();

    const runSecond = async (second: ScriptStep) => {
      const env = await makeEnv({ capabilities: exactTarget() });
      env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
      env.gateway.script.push(answeredBy(textStep('Done.', { usage: usageOf(firstCount - 50, 5) }), 'secondary'), second);
      const one = await env.enqueue(TASK);
      await env.runOnce(env.worker());
      const two = await env.enqueue('Now the second task');
      await env.runOnce(env.worker('worker-2'));
      return { first: env.ofType(one.id, 'meter.observed'), second: env.ofType(two.id, 'meter.observed') };
    };

    const byAlias = await runSecond(textStep('Again.'));
    expect(byAlias.first).toMatchObject([{ target: 'secondary', fallback: true, counted: firstCount, reported: firstCount - 50, kept: firstCount }]);
    expect(byAlias.second).toMatchObject([{ target: PRIMARY_TARGET, fallback: false, known: 0, counted: secondCount }]);

    const byFallback = await runSecond(answeredBy(textStep('Again.'), 'secondary'));
    expect(byFallback.second).toMatchObject([{ target: 'secondary', fallback: true, known: firstCount, counted: secondCount }]);
  });
});
