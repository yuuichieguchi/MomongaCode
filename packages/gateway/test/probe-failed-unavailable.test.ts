import { createRedactor } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { TARGET_PROBE_FAILED, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import type { Capabilities, ProviderAdapter } from '@momonga/protocol';
import { acquireProbeLock, createAutoProbe, createInstanceProbe } from '@momonga/gateway';
import type { ProbeSubject } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, createScriptedAdapter, testKernelLock } from '@momonga/testkit';
import { targetProbingError } from '../src/probe/auto-probe.ts';
import { START_MS, getJson, makeDir, startGateway } from './gateway-helpers.ts';
import { until } from './gateway-process-helpers.ts';

type LanternKey = { target: string; lamp: string };
type LanternReport = { brightness: number };

const KEY: LanternKey = { target: 'endpoint-558c9de05f1b6c0ca10901925527c27e', lamp: 'brass-7' };
const SHOWN = 'ollama-127.0.0.1-18477/think-c';
const DECLARATION = `declare toolCalling for the model "${SHOWN}" in its settings`;
const ASK = { fields: ['toolCalling'], declaration: DECLARATION, model: SHOWN };
const RETRY_AFTER_MS = 120_000;
const CAUSE = 'the lantern went out';
const FAILED_MESSAGE = `measuring the model "${SHOWN}" failed: ${CAUSE}. It is not measured again until you ask: ${DECLARATION}, or run \`momonga gateway probe ${SHOWN}\`.`;
const PROBING = { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: expect.objectContaining({ fields: ['toolCalling'], declaration: DECLARATION }) };

type Pending = { resolve: (report: LanternReport) => void; reject: (error: Error) => void };

const lantern = () => {
  const state = { measures: 0, saved: [] as LanternReport[], pending: [] as Pending[] };
  const subject: ProbeSubject<LanternKey, LanternReport> = {
    target: KEY.target,
    unknown: ASK,
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
  const dir = makeDir();
  const timers = createFakeTimers(clock);
  const autoProbe = createAutoProbe({ redactor: createRedactor({ credentials: [] }), lock: testKernelLock(), dir, clock, timers, retryAfterMs: RETRY_AFTER_MS, onEvent: (event) => events.push(event.kind) });
  return { clock, timers, events, dir, autoProbe, ...lantern() };
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

  it('keeps the failed state with its cause, without a retry time, and starts no measurement again however late the next request comes', async () => {
    const context = setupAuto();
    await failFirstFlight(context, new Error(CAUSE));

    const atOnce = await thrownBy(() => context.autoProbe.ensure(context.subject, KEY));
    expect(atOnce).toMatchObject({ status: 503, body: { type: 'server_error', code: TARGET_PROBE_FAILED, message: FAILED_MESSAGE }, headers: {} });

    context.clock.advance(10 * RETRY_AFTER_MS);
    expect(await thrownBy(() => context.autoProbe.ensure(context.subject, KEY))).toMatchObject({ body: { code: TARGET_PROBE_FAILED, message: FAILED_MESSAGE } });
    expect(context.state.measures).toBe(1);
  });

  it('names the model as the person sees it when the server is not ready, not the key of its record', async () => {
    const context = setupAuto();
    const refused = { ...context.subject, precondition: { boundMs: 50, check: async () => ({ kind: 'refused', message: `the Ollama server does not list the model "think-c"`, detail: 'GET /api/tags has no entry for it', remedy: 'ollama pull think-c' }) as const } };
    expect(await thrownBy(() => context.autoProbe.ensure(refused, KEY))).toMatchObject({ body: { message: `the model "${SHOWN}" is not ready: the Ollama server does not list the model "think-c" (GET /api/tags has no entry for it); remedy: ollama pull think-c` } });
  });

  it('names the model as the person sees it when another process holds the measurement longer than the wait', async () => {
    const context = setupAuto();
    const held = await acquireProbeLock(context.dir, KEY, 'another process', testKernelLock());
    await context.autoProbe.ensure(context.subject, KEY);
    context.state.pending[0]?.resolve({ brightness: 1 });
    await until(async () => {
      if (context.timers.pending().length > 0) await context.timers.advanceAsync(RETRY_AFTER_MS);
      return context.events.includes('failed');
    }, 'the wait for the lock ends');
    held.release();
    expect(await thrownBy(() => context.autoProbe.ensure(context.subject, KEY))).toMatchObject({
      body: { message: `measuring the model "${SHOWN}" failed: the model "${SHOWN}" is already being measured (once per probe key); run the command again when it finishes. It is not measured again until you ask: ${DECLARATION}, or run \`momonga gateway probe ${SHOWN}\`.` },
    });
  });

  it('names the model as it is named when the answer is given, so each subject sharing the record gets its own name and a command that names it', async () => {
    const context = setupAuto();
    await failFirstFlight(context, new Error(CAUSE));
    const renamed = 'ollama-127.0.0.1-18477/think-c:latest';
    const renamedDeclaration = `declare toolCalling for the model "${renamed}" in its settings`;
    const now = { ...context.subject, unknown: { fields: ['toolCalling'], declaration: renamedDeclaration, model: renamed } };
    expect(await thrownBy(() => context.autoProbe.ensure(now, KEY))).toMatchObject({ body: { message: `measuring the model "${renamed}" failed: ${CAUSE}. It is not measured again until you ask: ${renamedDeclaration}, or run \`momonga gateway probe ${renamed}\`.` } });
    expect(await thrownBy(() => context.autoProbe.ensure(context.subject, KEY))).toMatchObject({ body: { message: FAILED_MESSAGE } });
  });

  it('cleans the cause and keeps it at most 300 characters', async () => {
    const context = setupAuto();
    await failFirstFlight(context, new Error(`\u001b[31mwick\u0007 ${'x'.repeat(2000)}`));

    const failure = (await thrownBy(() => context.autoProbe.ensure(context.subject, KEY))) as { body: { message: string } };
    const prefix = `measuring the model "${SHOWN}" failed: `;
    expect(failure.body.message.startsWith(`${prefix}wick x`)).toBe(true);
    expect(failure.body.message.slice(prefix.length, failure.body.message.indexOf('. It is not measured again')).length).toBeLessThanOrEqual(300);
  });
});

const setupInstance = () => {
  const clock = createFakeClock(START_MS);
  const pending: Pending[] = [];
  const failures: unknown[] = [];
  const probe = createInstanceProbe<LanternReport>({ redactor: createRedactor({ credentials: [] }),
    target: KEY.target,
    unknown: { component: 'hostOsBuild', reason: 'sw_vers is not on PATH' },
    ask: ASK,
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

  it('keeps the failed state of its instance, and measures it no more however late the next poll comes', async () => {
    const context = setupInstance();
    await failInstanceFlight(context, 0, new Error(CAUSE));

    expect(await thrownBy(() => context.probe.ensure())).toMatchObject({ status: 503, body: { type: 'server_error', code: TARGET_PROBE_FAILED, message: FAILED_MESSAGE } });
    context.clock.advance(10 * RETRY_AFTER_MS);
    expect(await thrownBy(() => context.probe.ensure())).toMatchObject({ body: { code: TARGET_PROBE_FAILED, message: FAILED_MESSAGE } });
    expect(context.pending).toHaveLength(1);
  });

  it('measures a restarted instance at once: the failed state belongs to the instance whose measurement failed', async () => {
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
  it('lists it probing while measured, then unavailable with the cause and code, and keeps it so', async () => {
    const clock = createFakeClock(START_MS);
    const events: string[] = [];
    const autoProbe = createAutoProbe({ redactor: createRedactor({ credentials: [] }), lock: testKernelLock(), dir: makeDir(), clock, timers: createFakeTimers(clock), retryAfterMs: RETRY_AFTER_MS, onEvent: (event) => events.push(event.kind) });
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

    clock.advance(10 * RETRY_AFTER_MS);
    expect((await listed(MEASURED)).capabilities).toEqual(UNAVAILABLE);
    expect(state.measures).toBe(1);
  });
});
