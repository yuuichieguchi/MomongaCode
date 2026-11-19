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

const LIST_CAP = PLAN_SIGN_IN_DEFAULTS.catalogBodyBytes;
const ERROR_CAP = PLAN_SIGN_IN_DEFAULTS.authBodyBytes;

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
  it('the model list has its own bound of 16 MiB, apart from the auth document cap', () => {
    expect(LIST_CAP).toBe(16 * 1024 * 1024);
    expect(ERROR_CAP).toBe(256 * 1024);
  });

  it('a 200 model list over its bound writes plan.catalog list_invalid with requestIdHeaders ["x-request-id"] and rejects naming the bound', async () => {
    const { read, events } = await catalogRead(async () => streamedBody(200, LIST_CAP + 1, { 'x-request-id': 'req_1' }).response);
    await expect(read).rejects.toThrow(`the ChatGPT model list is larger than ${LIST_CAP} bytes`);
    const event = catalogEvent(events);
    expect(event['outcome']).toBe('list_invalid');
    expect(event['requestIdHeaders']).toEqual(['x-request-id']);
  });

  it('a 200 model list above the auth document cap and within its bound is read, not refused as over the cap', async () => {
    const entry = { slug: 'gpt-big', display_name: 'GPT Big', visibility: 'list', context_window: 272000, base_instructions: 'x'.repeat(ERROR_CAP * 2) };
    const { read, events } = await catalogRead(async () => new Response(JSON.stringify({ models: [entry] }), { status: 200 }));
    await expect(read).resolves.toMatchObject({ models: [{ slug: 'gpt-big', usable: true, contextWindow: 272000 }] });
    expect(catalogEvent(events)['outcome']).toBe('ok');
  });

  it('a 500 model list with an over-cap body writes the classified code with requestIdHeaders', async () => {
    const small = await catalogRead(async () => new Response('', { status: 500, headers: { 'x-request-id': 'req_1' } }));
    await expect(small.read).rejects.toThrow();
    const classified = catalogEvent(small.events)['outcome'];
    const { read, events } = await catalogRead(async () => streamedBody(500, ERROR_CAP + 1, { 'x-request-id': 'req_1' }).response);
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
