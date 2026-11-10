import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { PRIMARY_TARGET, fakeCounterOf } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const OTHER_TARGET = 'elsewhere';

const isModelRequested = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'model.requested' && 'body' in value;

const requestedIn = (value: unknown, depth = 0): number => {
  if (depth > 4 || typeof value !== 'object' || value === null) return 0;
  if (isModelRequested(value)) return 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((sum: number, child) => sum + requestedIn(child, depth + 1), 0);
};

const countingUntilFirstRequest = (env: Env): { store: RuntimeStore; returned: () => number } => {
  let returned = 0;
  let starting = true;
  const store = new Proxy(env.store, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'append' && requestedIn(args[1]) > 0) starting = false;
        const result: unknown = (value as (...parameters: unknown[]) => unknown).apply(target, args);
        if (starting) returned += requestedIn(result);
        return result;
      };
    },
  });
  return { store, returned: () => returned };
};

const threeSteps = (tag: string) => [
  callsStep([{ callId: `call_${tag}_1`, name: 'Echo', args: { value: `${tag} one` } }]),
  callsStep([{ callId: `call_${tag}_2`, name: 'Echo', args: { value: `${tag} two` } }]),
  textStep(`${tag} done.`),
];

describe('the claim start folds the reports of the meter counter and reads only the request bodies the fold keeps', () => {
  it('folds the latest report of the same counter from another model, skips a later report of another counter, and returns at most one model.requested to the claim start', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(16384, { maxOutputTokens: 1024 }) });
    const aliasOf = env.session.model;
    env.gateway.chainsByModel[aliasOf] = [PRIMARY_TARGET];
    env.gateway.chainsByModel['twin-model'] = [PRIMARY_TARGET];
    env.gateway.chainsByModel['other-model'] = [OTHER_TARGET];
    env.gateway.script.push(...threeSteps('a'));
    const first = env.enqueue('First task');
    await env.runOnce(env.worker());
    env.gateway.script.push(...threeSteps('c'));
    const third = env.enqueue('Second task');
    await env.runOnce(env.worker());
    env.setModel('twin-model');
    env.gateway.script.push(...threeSteps('t'));
    const twin = env.enqueue('Task for the twin model with a longer text than the others');
    await env.runOnce(env.worker());
    env.setModel('other-model');
    env.gateway.script.push(...threeSteps('b'));
    const other = env.enqueue('Task for the other model, whose first target counts with another counter');
    await env.runOnce(env.worker());
    env.setModel(aliasOf);

    for (const run of [first, third, twin, other]) expect(env.run(run.id).status).toBe('COMPLETED');
    for (const request of env.ofType(twin.id, 'model.requested')) expect((request.body as { model?: unknown }).model).toBe('twin-model');
    for (const request of env.ofType(other.id, 'model.requested')) expect((request.body as { model?: unknown }).model).toBe('other-model');
    expect(env.ofType(first.id, 'meter.observed')).toHaveLength(3);
    expect(env.ofType(third.id, 'meter.observed')).toHaveLength(3);
    const twinObserved = env.ofType(twin.id, 'meter.observed');
    const otherObserved = env.ofType(other.id, 'meter.observed');
    expect(twinObserved).toHaveLength(3);
    expect(otherObserved).toHaveLength(3);
    for (const event of twinObserved) expect(event).toMatchObject({ target: PRIMARY_TARGET, counter: fakeCounterOf(PRIMARY_TARGET), fallback: false });
    for (const event of otherObserved) expect(event).toMatchObject({ target: OTHER_TARGET, counter: fakeCounterOf(OTHER_TARGET), fallback: false });
    const latestTwin = twinObserved.at(-1);
    const latestOther = otherObserved.at(-1);
    const latestThird = env.ofType(third.id, 'meter.observed').at(-1);
    if (latestTwin === undefined || latestOther === undefined || latestThird === undefined) throw new Error('a run reported nothing');
    expect(new Set([latestTwin.kept, latestOther.kept, latestThird.kept]).size).toBe(3);

    const streamsBefore = env.gateway.streams.length;
    const { store, returned } = countingUntilFirstRequest(env);
    env.gateway.script.push(textStep('New run done.'));
    const next = env.enqueue('The new task');
    await env.runOnce(env.worker('worker-2', { store }));

    expect(env.run(next.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.length).toBe(streamsBefore + 1);
    expect(returned()).toBeLessThanOrEqual(1);
    expect(env.ofType(next.id, 'meter.observed')[0]).toMatchObject({ target: PRIMARY_TARGET, counter: fakeCounterOf(PRIMARY_TARGET), fallback: false, known: latestTwin.kept });
  });
});
