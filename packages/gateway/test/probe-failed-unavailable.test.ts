import { describe, expect, it } from 'vitest';
import { TARGET_PROBE_FAILED, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Capabilities, ProviderAdapter } from '@momonga/protocol';
import { createAutoProbe, createInstanceProbe } from '@momonga/gateway';
import type { ProbeSubject } from '@momonga/gateway';
import { createFakeClock, createScriptedAdapter } from '@momonga/testkit';
import { targetProbingError } from '../src/probe/auto-probe.ts';
import { START_MS, getJson, makeDir, startGateway } from './gateway-helpers.ts';
import { until } from './gateway-process-helpers.ts';

type LanternKey = { target: string; lamp: string };
type LanternReport = { brightness: number };

const KEY: LanternKey = { target: 'lantern', lamp: 'brass-7' };
const RETRY_AFTER_MS = 120_000;
const CAUSE = 'the lantern went out';
const FAILED_MESSAGE = `measuring this model failed: ${CAUSE}`;
const PROBING = { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 };

type Pending = { resolve: (report: LanternReport) => void; reject: (error: Error) => void };

const lantern = () => {
  const state = { measures: 0, saved: [] as LanternReport[], pending: [] as Pending[] };
  const subject: ProbeSubject<LanternKey, LanternReport> = {
    target: KEY.target,
    readKey: async () => KEY,
    precondition: { boundMs: 50, check: async () => ({ kind: 'met' }) },
    measure: () => {
      state.measures += 1;
      return new Promise((resolve, reject) => state.pending.push({ resolve, reject }));
    },
    save: async (_key, report) => {
      state.saved.push(report);
    },
  };
  return { state, subject };
};

const setupAuto = () => {
  const clock = createFakeClock(START_MS);
  const events: string[] = [];
  const autoProbe = createAutoProbe({ dir: makeDir(), clock, retryAfterMs: RETRY_AFTER_MS, onEvent: (event) => events.push(event.kind) });
  return { clock, events, autoProbe, ...lantern() };
};

const failFirstFlight = async (context: ReturnType<typeof setupAuto>, error: Error): Promise<void> => {
  await context.autoProbe.ensure(context.subject, KEY);
  context.state.pending[0]?.reject(error);
  await until(() => context.events.includes('failed'), 'the failure is reported');
};

const thrownBy = (work: () => Promise<unknown>): Promise<unknown> =>
  work().then(
    (value) => {
      throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );

describe('the automatic probe reports a failed measurement as its cause (design-screens 6.2, D-1)', () => {
  it('answers probing while the measurement runs', async () => {
    const context = setupAuto();
    expect(await context.autoProbe.ensure(context.subject, KEY)).toEqual(PROBING);
    expect(await context.autoProbe.ensure(context.subject, KEY)).toEqual(PROBING);
    expect(context.state.measures).toBe(1);
  });

  it('throws 503 target_probe_failed with the cause and the remaining back-off during the back-off, and starts no measurement', async () => {
    const context = setupAuto();
    await failFirstFlight(context, new Error(CAUSE));

    const atOnce = await thrownBy(() => context.autoProbe.ensure(context.subject, KEY));
    expect(atOnce).toMatchObject({
      status: 503,
      body: { type: 'server_error', code: TARGET_PROBE_FAILED, message: FAILED_MESSAGE },
      headers: { 'retry-after': '120' },
    });

    context.clock.advance(45_000);
    const later = await thrownBy(() => context.autoProbe.ensure(context.subject, KEY));
    expect(later).toMatchObject({ status: 503, body: { code: TARGET_PROBE_FAILED, message: FAILED_MESSAGE }, headers: { 'retry-after': '75' } });

    context.clock.advance(74_001);
    expect(await thrownBy(() => context.autoProbe.ensure(context.subject, KEY))).toMatchObject({ headers: { 'retry-after': '1' } });
    expect(context.state.measures).toBe(1);
  });

  it('starts a new measurement and answers probing once the back-off has passed', async () => {
    const context = setupAuto();
    await failFirstFlight(context, new Error(CAUSE));

    context.clock.advance(RETRY_AFTER_MS);

    expect(await context.autoProbe.ensure(context.subject, KEY)).toEqual(PROBING);
    expect(context.state.measures).toBe(2);
    expect(await context.autoProbe.ensure(context.subject, KEY)).toEqual(PROBING);
  });

  it('reports the cause of the latest failed measurement', async () => {
    const context = setupAuto();
    await failFirstFlight(context, new Error(CAUSE));
    context.clock.advance(RETRY_AFTER_MS);
    await context.autoProbe.ensure(context.subject, KEY);
    context.state.pending[1]?.reject(new Error('the oil ran dry'));
    await until(() => context.events.length === 2, 'the second failure is reported');

    expect(await thrownBy(() => context.autoProbe.ensure(context.subject, KEY))).toMatchObject({
      body: { code: TARGET_PROBE_FAILED, message: 'measuring this model failed: the oil ran dry' },
    });
  });

  it('cleans the cause and keeps it at most 300 characters', async () => {
    const context = setupAuto();
    await failFirstFlight(context, new Error(`\u001b[31mwick\u0007 ${'x'.repeat(2000)}`));

    const failure = (await thrownBy(() => context.autoProbe.ensure(context.subject, KEY))) as { body: { message: string } };
    const prefix = 'measuring this model failed: ';
    expect(failure.body.message.startsWith(`${prefix}wick x`)).toBe(true);
    expect(failure.body.message.length - prefix.length).toBeLessThanOrEqual(300);
  });
});

const setupInstance = () => {
  const clock = createFakeClock(START_MS);
  const pending: Pending[] = [];
  const failures: unknown[] = [];
  const probe = createInstanceProbe<LanternReport>({
    target: 'lantern',
    unknown: { component: 'hostOsBuild', reason: 'sw_vers is not on PATH' },
    dir: makeDir(),
    measure: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    retryAfterMs: RETRY_AFTER_MS,
    clock,
    onNotice: () => undefined,
    onFailure: (error) => failures.push(error),
  });
  return { clock, pending, failures, probe };
};

const failInstanceFlight = async (context: ReturnType<typeof setupInstance>, index: number, error: Error): Promise<void> => {
  await context.probe.ensure();
  context.pending[index]?.reject(error);
  await until(() => context.failures.length === index + 1, 'the failure is reported');
};

describe('the probe of an instance whose key cannot be read reports a failed measurement as its cause (design-screens 6.2, D-1)', () => {
  it('answers probing while the measurement runs', async () => {
    const context = setupInstance();
    expect(await context.probe.ensure()).toEqual({ kind: 'probing', probing: PROBING });
    expect(await context.probe.ensure()).toEqual({ kind: 'probing', probing: PROBING });
    expect(context.pending).toHaveLength(1);
  });

  it('throws 503 target_probe_failed with the cause and the remaining back-off, and does not measure again on every poll', async () => {
    const context = setupInstance();
    await failInstanceFlight(context, 0, new Error(CAUSE));

    expect(await thrownBy(() => context.probe.ensure())).toMatchObject({
      status: 503,
      body: { type: 'server_error', code: TARGET_PROBE_FAILED, message: FAILED_MESSAGE },
      headers: { 'retry-after': '120' },
    });
    context.clock.advance(45_000);
    expect(await thrownBy(() => context.probe.ensure())).toMatchObject({ body: { code: TARGET_PROBE_FAILED, message: FAILED_MESSAGE }, headers: { 'retry-after': '75' } });
    expect(context.pending).toHaveLength(1);
  });

  it('measures again once the back-off has passed, and serves the result of a successful retry', async () => {
    const context = setupInstance();
    await failInstanceFlight(context, 0, new Error(CAUSE));
    context.clock.advance(RETRY_AFTER_MS);

    expect(await context.probe.ensure()).toEqual({ kind: 'probing', probing: PROBING });
    expect(context.pending).toHaveLength(2);
    context.pending[1]?.resolve({ brightness: 3 });
    await until(async () => (await context.probe.ensure()).kind === 'measured', 'the retry is measured');

    expect(await context.probe.ensure()).toEqual({ kind: 'measured', report: { brightness: 3 } });
  });

  it('measures a restarted instance at once: the back-off belongs to the instance whose measurement failed', async () => {
    const context = setupInstance();
    await failInstanceFlight(context, 0, new Error(CAUSE));

    context.probe.restarted();

    expect(await context.probe.ensure()).toEqual({ kind: 'probing', probing: PROBING });
    expect(context.pending).toHaveLength(2);
  });
});

const KEY_VALUE = 'listing-credential-value-0001';

const AVAILABLE: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 4,
  source: 'declared',
};

type Entry = { id: string; capabilities: Record<string, unknown>; chain: Array<{ model: string; capabilities: Record<string, unknown> }> };

const MEASURED = 'p/model-m';
const MIXED = 'p/model-b';

const memberOf = (entry: Entry, model: string): Record<string, unknown> | undefined => entry.chain.find((member) => member.model === model)?.capabilities;

const UNAVAILABLE = { toolCalling: { state: 'unavailable', status: 503, type: 'server_error', code: 'target_probe_failed', message: FAILED_MESSAGE }, source: 'unprobed' };
const LISTED_PROBING = { toolCalling: PROBING, source: 'unprobed' };

describe('the models listing of a model whose measurement failed (design-screens 6.2, items 1 and 4)', () => {
  it('lists it probing while measured, unavailable with the cause and code after the failure and during the back-off, probing at the retry and measured after it', async () => {
    const clock = createFakeClock(START_MS);
    const events: string[] = [];
    const autoProbe = createAutoProbe({ dir: makeDir(), clock, retryAfterMs: RETRY_AFTER_MS, onEvent: (event) => events.push(event.kind) });
    const { state, subject } = lantern();
    const measured: ProviderAdapter = {
      ...createScriptedAdapter({ calls: [], capabilities: AVAILABLE }),
      capabilities: async () => {
        if (state.saved.length > 0) return AVAILABLE;
        throw targetProbingError(await autoProbe.ensure(subject, KEY));
      },
    };
    const { client } = await startGateway({
      credentials: [KEY_VALUE],
      adapters: { [MEASURED]: measured, [MIXED]: createScriptedAdapter({ calls: [], capabilities: AVAILABLE }) },
      config: { targets: { [MEASURED]: {}, [MIXED]: {} }, chains: { [MIXED]: [MIXED, MEASURED] } },
      clock,
    });
    const listed = async (id: string): Promise<Entry> => {
      const response = await getJson(client, '/v1/momonga/models');
      expect(response.status).toBe(200);
      const found = (response.body.data as Entry[]).find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`no entry ${id}`);
      return found;
    };

    expect((await listed(MEASURED)).capabilities).toEqual(LISTED_PROBING);

    state.pending[0]?.reject(new Error(CAUSE));
    await until(() => events.includes('failed'), 'the failure is reported');
    const failed = await listed(MEASURED);
    expect(failed.capabilities).toEqual(UNAVAILABLE);
    expect(memberOf(failed, MEASURED)).toEqual(UNAVAILABLE);
    const mixed = await listed(MIXED);
    expect(memberOf(mixed, MEASURED)).toEqual(UNAVAILABLE);
    expect(memberOf(mixed, MIXED)?.['contextWindow']).toBe(8192);

    clock.advance(45_000);
    expect((await listed(MEASURED)).capabilities).toEqual(UNAVAILABLE);
    expect(state.measures).toBe(1);

    clock.advance(75_000);
    expect((await listed(MEASURED)).capabilities).toEqual(LISTED_PROBING);
    const retried = state.pending.length;
    expect(state.measures).toBe(retried);
    expect(retried).toBeGreaterThan(1);

    state.pending[retried - 1]?.resolve({ brightness: 3 });
    await until(() => state.saved.length === 1, 'the retry is saved');
    const ready = await listed(MEASURED);
    expect(ready.capabilities['contextWindow']).toBe(8192);
    expect(ready.capabilities['toolCalling']).toBe('native');
  });
});
