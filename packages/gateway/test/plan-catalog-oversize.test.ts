import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_SIGN_IN_DEFAULTS } from '../src/defaults.ts';
import { createPlanCatalog } from '../src/plan/catalog.ts';
import type { PlanFetch } from '../src/plan/refresh.ts';
import { fakeAuth } from './plan-auth-support.ts';
import { resettingFetch, startHarness } from './plan-support.ts';
import type { Harness, RecordedPlanEvent } from './plan-support.ts';
import { streamedBody } from './plan-send-fakes.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const CAP = PLAN_SIGN_IN_DEFAULTS.authBodyBytes;

const boundSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const catalogRead = async (fetch: PlanFetch) => {
  const h = await startHarness();
  harnesses.push(h);
  const events: RecordedPlanEvent[] = [];
  const catalog = createPlanCatalog({
    store: h.store,
    clock: h.clock,
    outbound: (_signal, use) => use(fetch),
    sleep: boundSleep,
    events: (name, data) => {
      events.push({ name, data: data as Record<string, unknown> });
    },
  });
  const read = catalog.read({ profile: h.profile, account: 'work', refresh: true, auth: fakeAuth(), signal: new AbortController().signal });
  return { read, events };
};

const catalogEvent = (events: RecordedPlanEvent[]): Record<string, unknown> => {
  const found = events.filter((event) => event.name === 'plan.catalog');
  expect(found).toHaveLength(1);
  return found[0]?.data ?? {};
};

describe('plan.catalog names the request-id headers whenever a response was received (P-G7)', () => {
  it('a 200 model list over the cap writes plan.catalog list_invalid with requestIdHeaders ["x-request-id"] and rejects', async () => {
    const { read, events } = await catalogRead(async () => streamedBody(200, CAP + 1, { 'x-request-id': 'req_1' }).response);
    await expect(read).rejects.toThrow();
    const event = catalogEvent(events);
    expect(event['outcome']).toBe('list_invalid');
    expect(event['requestIdHeaders']).toEqual(['x-request-id']);
  });

  it('a 500 model list with an over-cap body writes the classified code with requestIdHeaders', async () => {
    const small = await catalogRead(async () => new Response('', { status: 500, headers: { 'x-request-id': 'req_1' } }));
    await expect(small.read).rejects.toThrow();
    const classified = catalogEvent(small.events)['outcome'];
    const { read, events } = await catalogRead(async () => streamedBody(500, CAP + 1, { 'x-request-id': 'req_1' }).response);
    await expect(read).rejects.toThrow();
    const event = catalogEvent(events);
    expect(event['outcome']).toBe(classified);
    expect(event['requestIdHeaders']).toEqual(['x-request-id']);
  });

  it('an unanswered list (connection reset) writes the classified code and no requestIdHeaders', async () => {
    const { read, events } = await catalogRead(resettingFetch());
    await expect(read).rejects.toThrow();
    const event = catalogEvent(events);
    expect(event['outcome']).toBe('provider_unavailable');
    expect(event).not.toHaveProperty('requestIdHeaders');
  });
});
