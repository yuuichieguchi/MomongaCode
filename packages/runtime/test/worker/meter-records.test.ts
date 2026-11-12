import { describe, expect, it } from 'vitest';
import { TOKEN_SETTINGS_OFF } from './fake-settings.ts';
import { foldMeter } from '@momonga/context';
import type { ObservedEvent } from '@momonga/context';
import type { Capabilities, RunEvent, RunEventPayload } from '@momonga/protocol';
import { foldMeterFor } from '../../src/worker/meter-journal.ts';
import { capabilitiesFor, createdRun, makeEnv } from './harness.ts';
import { DEADLINE_MS } from './harness.ts';
import { textStep } from './scripts.ts';

const COUNTER = 'counter-a';
const WINDOW_RUNS = 6;

const requestBody = (label: string) => ({ model: 'fm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: label }] }], tools: [] });

const requestedOf = (step: number, label: string): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d-${label}`, body: requestBody(label) });

const observedOf = (capabilities: Capabilities, index: number): RunEventPayload => ({
  type: 'meter.observed',
  target: 'primary',
  counter: COUNTER,
  fallback: false,
  inputDigest: `input-${100 + index}`,
  itemCount: 100 + index,
  counted: 100 + index,
  reported: 110 + index,
  kept: 100 + index,
  known: 100,
  uncounted: 100 + index,
  miss: index % 7,
  contextWindow: capabilities.contextWindow,
  ...(capabilities.tokenErrorRatio === undefined ? {} : { tokenErrorRatio: capabilities.tokenErrorRatio }),
  tokenCounting: capabilities.tokenCounting,
});

const SMALL = capabilitiesFor(4000);
const LARGE = capabilitiesFor(8000);

const sessionWithRuns = async (runs: number, eventsPerRun: number) => {
  const decoded = { rows: 0, bytes: 0, counting: false };
  const env = await makeEnv({
    onDecode: (rows, bytes) => {
      if (!decoded.counting) return;
      decoded.rows += rows;
      decoded.bytes += bytes;
    },
  });
  env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
  let index = 0;
  for (let at = 0; at < runs; at += 1) {
    env.clock.advance(1);
    const run = await createdRun(await env.store.createRunAndEnqueue(env.session.id, { input: 'Past work', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
    const payloads: RunEventPayload[] = [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { model: 'fm' }, mode: 'manual' }];
    for (let inRun = 0; inRun < eventsPerRun; inRun += 1) {
      const capabilities = index % 3 === 0 ? LARGE : SMALL;
      payloads.push(requestedOf(inRun + 1, `r${100 + at}-${inRun}`), observedOf(capabilities, index));
      index += 1;
    }
    const claim = await env.seed(run.id, payloads, 'hold');
    env.scriptContribution(run.id, []);
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  }
  return { env, decoded };
};

const todaysFold = (env: Awaited<ReturnType<typeof makeEnv>>, capabilities: Capabilities) => {
  const events = env.store
    .listRuns(env.session.id)
    .flatMap((run) => env.store.readRunEventsOfTypes(run.id, ['meter.observed']).filter((event): event is Extract<RunEvent, { type: 'meter.observed' }> => event.type === 'meter.observed'));
  return foldMeter(events, {
    counter: COUNTER,
    capabilities,
    bodyOf: (event: ObservedEvent) => {
      const { runId, seq } = event as Extract<RunEvent, { type: 'meter.observed' }>;
      const requested = env.store.readLatestRunEventBefore(runId, 'model.requested', seq);
      if (requested === undefined) throw new Error('no request');
      return requested.body;
    },
  });
};

describe('the meter of a session is a record written when meter.observed is appended (row 8g)', () => {
  it.each([
    ['the larger window', LARGE],
    ['the smaller window', SMALL],
  ])('restores the same memory as the fold of every meter.observed of the session for %s, over more events than the miss window holds', async (_name, capabilities) => {
    const { env } = await sessionWithRuns(WINDOW_RUNS, 5);
    expect(await foldMeterFor(env.store, env.session.id, capabilities, COUNTER)).toEqual(todaysFold(env, capabilities));
  });

  it('restores an empty memory for a key that was never observed', async () => {
    const { env } = await sessionWithRuns(2, 2);
    expect(await foldMeterFor(env.store, env.session.id, capabilitiesFor(12_345), COUNTER)).toEqual({ misses: [] });
  });

  it('decodes the same rows and bytes on the main thread whether the session holds 2 or 40 runs of events', async () => {
    const few = await sessionWithRuns(2, 3);
    const many = await sessionWithRuns(40, 3);
    few.decoded.counting = true;
    many.decoded.counting = true;
    expect((await foldMeterFor(many.env.store, many.env.session.id, SMALL, COUNTER)).misses).toHaveLength(20);
    expect((await foldMeterFor(few.env.store, few.env.session.id, SMALL, COUNTER)).latest).toBeDefined();
    const fewOnce = await decodedBy(few, () => foldMeterFor(few.env.store, few.env.session.id, SMALL, COUNTER));
    const manyOnce = await decodedBy(many, () => foldMeterFor(many.env.store, many.env.session.id, SMALL, COUNTER));
    expect(manyOnce).toEqual(fewOnce);
  });

  it('decodes the same rows and bytes from the start of a claim to the end of its run whether the session holds 2 or 40 runs of events', async () => {
    const counts = [];
    for (const runs of [2, 40]) {
      const { env, decoded } = await sessionWithRuns(runs, 3);
      env.gateway.script.push(textStep('Done.'));
      await env.enqueue('Next', { history: 'fresh' });
      decoded.rows = 0;
      decoded.bytes = 0;
      decoded.counting = true;
      await env.runOnce(env.worker('worker-1'));
      decoded.counting = false;
      counts.push({ rows: decoded.rows, bytes: decoded.bytes });
    }
    expect(counts[1]).toEqual(counts[0]);
  });
});

const decodedBy = async (session: { decoded: { rows: number; bytes: number; counting: boolean } }, read: () => Promise<unknown>): Promise<{ rows: number; bytes: number }> => {
  session.decoded.rows = 0;
  session.decoded.bytes = 0;
  session.decoded.counting = true;
  await read();
  session.decoded.counting = false;
  return { rows: session.decoded.rows, bytes: session.decoded.bytes };
};
