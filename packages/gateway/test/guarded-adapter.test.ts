import { REASONING_ORIGIN_CODEC } from './own-reasoning.ts';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import type {
  AdapterCompactRequest,
  AdapterContext,
  AdapterRequest,
  AdapterTarget,
  ClassifiedError,
  ProviderAdapter,
  StreamEvent,
} from '@momonga/protocol';
import { DEFAULT_SCRIPTED_CAPABILITIES, responseResource } from '@momonga/testkit';
import { ADAPTER_NEUTRAL_ERROR_CODES, SAMPLING_FIELDS } from '@momonga/protocol';
import { ClientDisconnectedError, GatewayError, SKIPPABLE_CODES, missingApiKeyError, runCancelledError } from '../src/core/errors.ts';
import { GuardedAdapterError, guardAdapter } from '../src/core/guarded-adapter.ts';
import { createRedactor } from '../src/core/redaction.ts';
import type { TargetRuntime } from '../src/core/router.ts';
import { REDACTED, TEST_API_KEY, expectRedacted } from './credential-support.ts';

const redactor = createRedactor({ credentials: [TEST_API_KEY] });
const TARGET: AdapterTarget = { name: 'primary', display: 'primary', model: 'scripted-primary' };
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, target: TARGET, attempt: 1, reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: DEFAULT_SCRIPTED_CAPABILITIES });
const REQUEST: AdapterRequest = { model: 'scripted-primary', input: [] };
const COMPACT_REQUEST: AdapterCompactRequest = { model: 'scripted-primary', input: [] };
const ECHO = `Incorrect API key provided: ${TEST_API_KEY}`;
const REDACTED_ECHO = `Incorrect API key provided: ${REDACTED}`;

const OPTIONAL_MEMBERS = ['countTokens', 'renderWire', 'compact', 'renderCompactWire', 'health'] as const;
type OptionalMember = (typeof OPTIONAL_MEMBERS)[number];

const classifiedOf = (message: string, code: string | null = 'invalid_api_key', param: string | null = null): ClassifiedError => ({
  retryable: false,
  retryAfterMs: 1500,
  error: { type: 'invalid_request', code, message, param },
});

async function* eventsOf(events: readonly StreamEvent[]): AsyncGenerator<StreamEvent> {
  yield* events;
}

const baseAdapter = (overrides: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
  kind: 'probe-kind',
  sampling: { renders: SAMPLING_FIELDS },
  relaysClientBody: [],
  capabilities: async () => DEFAULT_SCRIPTED_CAPABILITIES,
  toolChoiceWire: () => ({ forms: [], expressesRequired: true }),
  create: () => eventsOf([]),
  classify: (error) => classifiedOf(error instanceof Error ? error.message : String(error), 'adapter_error'),
  ...overrides,
});

const optionalImplementations = (record: (member: string, self: unknown) => void): Required<Pick<ProviderAdapter, OptionalMember>> => ({
  countTokens: async function (this: unknown) {
    record('countTokens', this);
    return { input_tokens: 3, method: 'estimated', error_bound: 1, error_shape: { ratio: 0, minimum: 1 } };
  },
  renderWire: function (this: unknown) {
    record('renderWire', this);
    return { messages: [] };
  },
  compact: async function (this: unknown) {
    record('compact', this);
    return {
      summary: 'short',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      usageSource: 'reported',
    };
  },
  renderCompactWire: function (this: unknown) {
    record('renderCompactWire', this);
    return { messages: [] };
  },
  health: async function (this: unknown) {
    record('health', this);
    return { ok: true };
  },
});

const rejectionOf = async (operation: () => unknown): Promise<unknown> => {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
};

const expectGuardedError = (error: unknown, message: string): GuardedAdapterError => {
  expect(error).toBeInstanceOf(GuardedAdapterError);
  const guarded = error as GuardedAdapterError;
  expect(guarded.message).toBe(message);
  expect(guarded.classified.error.message).toBe(message);
  expect('cause' in guarded).toBe(false);
  expect(guarded.stack ?? '').not.toContain(TEST_API_KEY);
  return guarded;
};

describe('guardAdapter optional members (G0)', () => {
  it('leaves every optional member undefined when the inner adapter has none', () => {
    const guard = guardAdapter(baseAdapter(), redactor, REASONING_ORIGIN_CODEC);
    for (const member of OPTIONAL_MEMBERS) expect(guard[member]).toBeUndefined();
  });

  it('defines every optional member when the inner adapter has all of them', () => {
    const guard = guardAdapter(baseAdapter(optionalImplementations(() => undefined)), redactor, REASONING_ORIGIN_CODEC);
    for (const member of OPTIONAL_MEMBERS) expect(typeof guard[member]).toBe('function');
  });

  it.for(OPTIONAL_MEMBERS)('defines only %s when the inner adapter has only that member', (member) => {
    const all = optionalImplementations(() => undefined);
    const guard = guardAdapter(baseAdapter({ [member]: all[member] }), redactor, REASONING_ORIGIN_CODEC);
    for (const other of OPTIONAL_MEMBERS) {
      if (other === member) expect(typeof guard[other]).toBe('function');
      else expect(guard[other]).toBeUndefined();
    }
  });

  it('passes kind through and delegates close (G5)', async () => {
    let closed = 0;
    const guard = guardAdapter(baseAdapter({ close: async () => void (closed += 1) }), redactor, REASONING_ORIGIN_CODEC);
    expect(guard.kind).toBe('probe-kind');
    await guard.close?.();
    expect(closed).toBe(1);
  });
});

describe('guardAdapter this binding', () => {
  it('runs every wrapped method with this equal to the inner adapter when called through the guard', async () => {
    const seen = new Map<string, unknown>();
    const record = (member: string, self: unknown): void => void seen.set(member, self);
    const inner: ProviderAdapter = {
      ...optionalImplementations(record),
      kind: 'probe-kind',
      sampling: { renders: SAMPLING_FIELDS },
      relaysClientBody: [],
      capabilities: async function (this: unknown) {
        record('capabilities', this);
        return DEFAULT_SCRIPTED_CAPABILITIES;
      },
      toolChoiceWire: function (this: unknown) {
        record('toolChoiceWire', this);
        return { forms: [], expressesRequired: true };
      },
      create: function (this: unknown) {
        record('create', this);
        return eventsOf([]);
      },
      classify: function (this: unknown) {
        record('classify', this);
        return classifiedOf('plain');
      },
    };
    const guard = guardAdapter(inner, redactor, REASONING_ORIGIN_CODEC);
    await guard.capabilities.call(guard, TARGET);
    for await (const _event of guard.create.call(guard, REQUEST, ctx())) void _event;
    guard.classify.call(guard, new Error('plain'));
    await guard.countTokens?.call(guard, { model: 'fast', input: 'one' }, ctx());
    guard.renderWire?.call(guard, REQUEST, TARGET, { reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: DEFAULT_SCRIPTED_CAPABILITIES });
    await guard.compact?.call(guard, COMPACT_REQUEST, ctx());
    guard.renderCompactWire?.call(guard, COMPACT_REQUEST, TARGET, 64, EVERY_REASONING_IS_OWN, DEFAULT_SCRIPTED_CAPABILITIES);
    await guard.health?.call(guard, TARGET);
    guard.toolChoiceWire?.call(guard, DEFAULT_SCRIPTED_CAPABILITIES, TARGET);
    expect([...seen.keys()].sort()).toEqual(
      ['capabilities', 'classify', 'compact', 'countTokens', 'create', 'health', 'renderCompactWire', 'renderWire', 'toolChoiceWire'].sort(),
    );
    for (const self of seen.values()) expect(self).toBe(inner);
  });
});

describe('every neutral and skip code survives the guard unchanged (W2)', () => {
  it.for([...ADAPTER_NEUTRAL_ERROR_CODES, ...SKIPPABLE_CODES])('keeps %s, so the redacted code classifies as the upstream code does', (code) => {
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf('plain', code) }), redactor, REASONING_ORIGIN_CODEC);
    expect(guard.classify(new Error('x')).error.code).toBe(code);
  });

  it('covers a non-empty set of codes', () => {
    expect(ADAPTER_NEUTRAL_ERROR_CODES.length).toBeGreaterThan(0);
    expect(SKIPPABLE_CODES.size).toBeGreaterThan(0);
  });
});

describe('guardAdapter classify (G1)', () => {
  it('redacts the message and keeps type, code, param, retryable and retryAfterMs', () => {
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf(ECHO, 'invalid_api_key', 'input[0]') }), redactor, REASONING_ORIGIN_CODEC);
    expect(guard.classify(new Error('x'))).toEqual({
      retryable: false,
      retryAfterMs: 1500,
      error: { type: 'invalid_request', code: 'invalid_api_key', message: REDACTED_ECHO, param: 'input[0]' },
    });
  });

  it('caps the classified message at 1024 characters', () => {
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf('z'.repeat(5000)) }), redactor, REASONING_ORIGIN_CODEC);
    expect(guard.classify(new Error('x')).error.message.length).toBeLessThanOrEqual(1024);
  });

  it.for([
    { label: 'a known code is kept', code: 'context_length_exceeded', expected: 'context_length_exceeded' },
    { label: 'a code of 64 characters is kept', code: 'c'.repeat(64), expected: 'c'.repeat(64) },
    { label: 'a code with dots, colons and dashes is kept', code: 'upstream.v1:bad-request', expected: 'upstream.v1:bad-request' },
    { label: 'a code of 65 characters fails the shape check and becomes upstream_error', code: 'c'.repeat(65), expected: 'upstream_error' },
    { label: 'a code of 70 characters fails the shape check and becomes upstream_error', code: 'c'.repeat(70), expected: 'upstream_error' },
    { label: 'a code with a space fails the shape check and becomes upstream_error', code: 'bad code', expected: 'upstream_error' },
    { label: 'an empty code fails the shape check and becomes upstream_error', code: '', expected: 'upstream_error' },
    { label: 'a code with a slash fails the shape check and becomes upstream_error', code: 'a/b', expected: 'upstream_error' },
    { label: 'a missing upstream code becomes upstream_error', code: null, expected: 'upstream_error' },
    { label: 'a code equal to the configured key is scrubbed and becomes upstream_error', code: TEST_API_KEY, expected: 'upstream_error' },
  ])('classify never leaves a failure without a code: $label', ({ code, expected }) => {
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf('plain', code) }), redactor, REASONING_ORIGIN_CODEC);
    expect(guard.classify(new Error('x')).error.code).toBe(expected);
  });

  it.for([
    { label: 'an encrypted_content param', param: 'input[0].encrypted_content', expected: 'input[0].encrypted_content' },
    { label: 'a joinParam param', param: 'tools[0].name', expected: 'tools[0].name' },
    { label: 'an env name param', param: 'MOMONGA_MISSING_KEY', expected: 'MOMONGA_MISSING_KEY' },
    { label: 'a param of 128 characters', param: 'p'.repeat(128), expected: 'p'.repeat(128) },
    { label: 'a param of 129 characters', param: 'p'.repeat(129), expected: null },
    { label: 'a param of 200 characters', param: 'p'.repeat(200), expected: null },
    { label: 'a param with a space', param: 'input 0', expected: null },
    { label: 'an empty param', param: '', expected: null },
    { label: 'a null param', param: null, expected: null },
    { label: 'a param equal to the configured key', param: TEST_API_KEY, expected: null },
  ])('maps $label to the param shape check result', ({ param, expected }) => {
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf('plain', 'invalid_body', param) }), redactor, REASONING_ORIGIN_CODEC);
    expect(guard.classify(new Error('x')).error.param).toBe(expected);
  });

  it('returns the classified body of a GuardedAdapterError without asking the inner adapter', () => {
    let innerCalls = 0;
    const guard = guardAdapter(
      baseAdapter({
        classify: () => {
          innerCalls += 1;
          return classifiedOf('inner');
        },
      }),
      redactor, REASONING_ORIGIN_CODEC);
    const classified = classifiedOf('already guarded');
    expect(guard.classify(new GuardedAdapterError(classified))).toBe(classified);
    expect(innerCalls).toBe(0);
  });
});

const failedEvent = (error: Record<string, unknown>): StreamEvent =>
  ({
    type: 'response.failed',
    sequence_number: 5,
    response: { ...responseResource({ id: 'upstream_resp_1', model: 'scripted-primary', status: 'failed' }), error },
  }) as unknown as StreamEvent;

const collect = async (iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
};

describe('guardAdapter create events (G2)', () => {
  it('rebuilds a response.failed error with a redacted message, a scrubbed code replaced by upstream_error, a shape-checked param, and no extra fields', async () => {
    const inner = baseAdapter({
      create: () => eventsOf([failedEvent({ code: 'bad code', type: 'server_error', message: ECHO, extra: TEST_API_KEY, param: 'p'.repeat(200) })]),
    });
    const [event] = await collect(guardAdapter(inner, redactor, REASONING_ORIGIN_CODEC).create(REQUEST, ctx()));
    const error = (event as { response: { error: unknown } }).response.error;
    expect(error).toEqual({ code: 'upstream_error', type: 'server_error', message: REDACTED_ECHO, param: null });
  });

  it('keeps a valid response.failed code and param', async () => {
    const inner = baseAdapter({
      create: () => eventsOf([failedEvent({ code: 'context_length_exceeded', type: 'invalid_request', message: 'too long', param: 'input[0].encrypted_content' })]),
    });
    const [event] = await collect(guardAdapter(inner, redactor, REASONING_ORIGIN_CODEC).create(REQUEST, ctx()));
    expect((event as { response: { error: unknown } }).response.error).toEqual({
      code: 'context_length_exceeded',
      type: 'invalid_request',
      message: 'too long',
      param: 'input[0].encrypted_content',
    });
  });

  it('redacts an error event message, replaces a scrubbed code by upstream_error and shape-checks its param', async () => {
    const inner = baseAdapter({
      create: () =>
        eventsOf([
          {
            type: 'error',
            sequence_number: 3,
            error: { message: `boom ${TEST_API_KEY}`, type: 'server_error', code: 'c'.repeat(70), param: 'input 0' },
          },
        ]),
    });
    const [event] = await collect(guardAdapter(inner, redactor, REASONING_ORIGIN_CODEC).create(REQUEST, ctx()));
    expect(event).toEqual({ type: 'error', sequence_number: 3, error: { message: `boom ${REDACTED}`, type: 'server_error', code: 'upstream_error', param: null } });
  });

  it('replaces a response.failed code and an error event code equal to the configured key by upstream_error, and nulls the param', async () => {
    const inner = baseAdapter({
      create: () =>
        eventsOf([
          { type: 'error', sequence_number: 3, error: { message: 'hiccup', type: 'server_error', code: TEST_API_KEY, param: TEST_API_KEY } },
          failedEvent({ code: TEST_API_KEY, type: 'server_error', message: 'failed', param: TEST_API_KEY }),
        ]),
    });
    const [errorEvent, failed] = await collect(guardAdapter(inner, redactor, REASONING_ORIGIN_CODEC).create(REQUEST, ctx()));
    expect((errorEvent as { error: unknown }).error).toEqual({ message: 'hiccup', type: 'server_error', code: 'upstream_error', param: null });
    expect((failed as { response: { error: unknown } }).response.error).toEqual({ code: 'upstream_error', type: 'server_error', message: 'failed', param: null });
  });

  it('passes other events through unchanged', async () => {
    const delta: StreamEvent = {
      type: 'response.output_text.delta',
      sequence_number: 4,
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: `model text ${TEST_API_KEY}`,
    };
    const events = await collect(guardAdapter(baseAdapter({ create: () => eventsOf([delta]) }), redactor, REASONING_ORIGIN_CODEC).create(REQUEST, ctx()));
    expect(events).toEqual([delta]);
  });
});

type IteratorFailure = 'next' | 'return' | 'throw';

const failingIterable = (failing: IteratorFailure): AsyncIterable<StreamEvent> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => {
      if (failing === 'next') throw new Error(`next failed: ${TEST_API_KEY}`);
      return { done: false, value: { type: 'response.output_text.delta', sequence_number: 1, item_id: 'm', output_index: 0, content_index: 0, delta: 'a' } };
    },
    return: async () => {
      if (failing === 'return') throw new Error(`return failed: ${TEST_API_KEY}`);
      return { done: true, value: undefined };
    },
    throw: async () => {
      if (failing === 'throw') throw new Error(`throw failed: ${TEST_API_KEY}`);
      return { done: true, value: undefined };
    },
  }),
});

describe('guardAdapter iterator wrapping', () => {
  it.for(['next', 'return', 'throw'] as const)('converts an error thrown by %s of the inner iterator into a redacted GuardedAdapterError', async (failing) => {
    const guard = guardAdapter(baseAdapter({ create: () => failingIterable(failing) }), redactor, REASONING_ORIGIN_CODEC);
    const iterator = guard.create(REQUEST, ctx())[Symbol.asyncIterator]();
    const error = await rejectionOf(async () => {
      if (failing === 'next') await iterator.next();
      if (failing === 'return') await iterator.return?.();
      if (failing === 'throw') await iterator.throw?.(new Error('consumer'));
    });
    const guarded = expectGuardedError(error, `${failing} failed: ${REDACTED}`);
    expect(guarded.classified.error.code).toBe('adapter_error');
  });
});

describe('guardAdapter thrown errors (G3)', () => {
  const throwing = (error: unknown): ProviderAdapter =>
    baseAdapter({
      capabilities: async () => {
        throw error;
      },
      create: () => {
        throw error;
      },
      countTokens: async () => {
        throw error;
      },
      compact: async () => {
        throw error;
      },
      renderWire: () => {
        throw error;
      },
      renderCompactWire: () => {
        throw error;
      },
    });

  const callers: Array<{ name: string; call: (guard: ProviderAdapter) => unknown }> = [
    { name: 'capabilities', call: (guard) => guard.capabilities(TARGET) },
    { name: 'create', call: (guard) => collect(guard.create(REQUEST, ctx())) },
    { name: 'countTokens', call: (guard) => guard.countTokens?.({ model: 'fast', input: 'one' }, ctx()) },
    { name: 'compact', call: (guard) => guard.compact?.(COMPACT_REQUEST, ctx()) },
    { name: 'renderWire', call: (guard) => guard.renderWire?.(REQUEST, TARGET, { reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: DEFAULT_SCRIPTED_CAPABILITIES }) },
    { name: 'renderCompactWire', call: (guard) => guard.renderCompactWire?.(COMPACT_REQUEST, TARGET, 64, EVERY_REASONING_IS_OWN, DEFAULT_SCRIPTED_CAPABILITIES) },
  ];

  it.for(callers)('$name turns an unknown error into a redacted GuardedAdapterError with no cause', async ({ call }) => {
    const original = new Error(`boom ${TEST_API_KEY}`, { cause: new Error(TEST_API_KEY) });
    const error = await rejectionOf(() => call(guardAdapter(throwing(original), redactor, REASONING_ORIGIN_CODEC)));
    const guarded = expectGuardedError(error, `boom ${REDACTED}`);
    expect(guarded.classified).toEqual({ retryable: false, retryAfterMs: 1500, error: { type: 'invalid_request', code: 'adapter_error', message: `boom ${REDACTED}`, param: null } });
  });

  it.for(callers)('$name rebuilds a GatewayError whose message carries the key, keeping status, type, code, param and headers', async ({ call }) => {
    const original = new GatewayError({
      status: 400,
      type: 'invalid_request',
      code: 'invalid_body',
      param: 'input[0]',
      headers: { 'retry-after': '2' },
      message: `bad body ${TEST_API_KEY}`,
    });
    const error = await rejectionOf(() => call(guardAdapter(throwing(original), redactor, REASONING_ORIGIN_CODEC)));
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).not.toBe(original);
    const rebuilt = error as GatewayError;
    expect(rebuilt.status).toBe(400);
    expect(rebuilt.headers).toEqual({ 'retry-after': '2' });
    expect(rebuilt.message).toBe(`bad body ${REDACTED}`);
    expect(rebuilt.body).toEqual({ type: 'invalid_request', code: 'invalid_body', param: 'input[0]', message: `bad body ${REDACTED}` });
    expectRedacted(rebuilt.stack ?? '', TEST_API_KEY);
  });

  it.for([
    { label: 'runCancelledError', make: () => runCancelledError() },
    { label: 'missingApiKeyError', make: () => missingApiKeyError('MOMONGA_TEST_KEY') },
    { label: 'a plain invalid_body error', make: () => new GatewayError({ status: 400, type: 'invalid_request', code: 'invalid_body', param: 'input[0]', message: 'bad body' }) },
  ])('returns $label unchanged as the same instance', async ({ make }) => {
    const original = make();
    const error = await rejectionOf(() => guardAdapter(throwing(original), redactor, REASONING_ORIGIN_CODEC).capabilities(TARGET));
    expect(error).toBe(original);
  });

  it('nulls a GatewayError param of 200 characters', async () => {
    const original = new GatewayError({ status: 400, type: 'invalid_request', code: 'invalid_body', param: 'p'.repeat(200), message: 'bad body' });
    const error = (await rejectionOf(() => guardAdapter(throwing(original), redactor, REASONING_ORIGIN_CODEC).capabilities(TARGET))) as GatewayError;
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.status).toBe(400);
    expect(error.body).toEqual({ type: 'invalid_request', code: 'invalid_body', param: null, message: 'bad body' });
  });

  it('replaces a GatewayError code equal to the configured key by upstream_error and nulls the param', async () => {
    const original = new GatewayError({ status: 400, type: 'invalid_request', code: TEST_API_KEY, param: TEST_API_KEY, message: 'bad body' });
    const error = (await rejectionOf(() => guardAdapter(throwing(original), redactor, REASONING_ORIGIN_CODEC).capabilities(TARGET))) as GatewayError;
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.status).toBe(400);
    expect(error.body).toEqual({ type: 'invalid_request', code: 'upstream_error', param: null, message: 'bad body' });
  });

  it('replaces a GatewayError code that fails the shape check by upstream_error', async () => {
    const original = new GatewayError({ status: 400, type: 'invalid_request', code: 'bad code', param: null, message: 'bad body' });
    const error = (await rejectionOf(() => guardAdapter(throwing(original), redactor, REASONING_ORIGIN_CODEC).capabilities(TARGET))) as GatewayError;
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.body.code).toBe('upstream_error');
  });

  it('rethrows a ClientDisconnectedError unchanged', async () => {
    const original = new ClientDisconnectedError();
    const error = await rejectionOf(() => collect(guardAdapter(throwing(original), redactor, REASONING_ORIGIN_CODEC).create(REQUEST, ctx())));
    expect(error).toBe(original);
  });
});

describe('guardAdapter health (G4)', () => {
  it('redacts detail and remediation', async () => {
    const guard = guardAdapter(
      baseAdapter({ health: async () => ({ ok: false, reason: 'precondition_failed', detail: `license ${TEST_API_KEY}`, remediation: `run ${TEST_API_KEY}` }) }),
      redactor, REASONING_ORIGIN_CODEC);
    expect(await guard.health?.(TARGET)).toEqual({ ok: false, reason: 'precondition_failed', detail: `license ${REDACTED}`, remediation: `run ${REDACTED}` });
  });

  it('turns a throwing health check into health_check_failed with a redacted detail', async () => {
    const guard = guardAdapter(
      baseAdapter({
        health: async () => {
          throw new Error(`probe ${TEST_API_KEY}`);
        },
      }),
      redactor, REASONING_ORIGIN_CODEC);
    expect(await guard.health?.(TARGET)).toEqual({ ok: false, reason: 'health_check_failed', detail: `probe ${REDACTED}` });
  });

  it('passes a healthy result through', async () => {
    const guard = guardAdapter(baseAdapter({ health: async () => ({ ok: true }) }), redactor, REASONING_ORIGIN_CODEC);
    expect(await guard.health?.(TARGET)).toEqual({ ok: true });
  });
});

describe('TargetRuntime.adapter type', () => {
  it('rejects a raw ProviderAdapter at compile time', () => {
    const raw: ProviderAdapter = baseAdapter();
    // @ts-expect-error
    const adapter: TargetRuntime['adapter'] = raw;
    expect(adapter).toBe(raw);
  });
});

const MATCHING_PLANS: ReadonlyArray<{ name: string; plan: Record<string, unknown> }> = [
  { name: 'a profile and an account that match', plan: { profile: 'chatgpt', account: 'work' } },
  { name: 'the longest label', plan: { profile: 'chatgpt', account: `a${'b'.repeat(127)}` } },
  { name: 'a matching profile and no account', plan: { profile: 'chatgpt' } },
];

const REFUSED_PLANS: ReadonlyArray<{ name: string; plan: Record<string, unknown> }> = [
  { name: 'a profile with a slash', plan: { profile: 'chat/gpt', account: 'work' } },
  { name: 'an account with a space', plan: { profile: 'chatgpt', account: 'wo rk' } },
  { name: 'an account with a line break', plan: { profile: 'chatgpt', account: 'work\nmore' } },
  { name: 'an account of 129 characters', plan: { profile: 'chatgpt', account: 'q'.repeat(129) } },
  { name: 'an empty account', plan: { profile: 'chatgpt', account: '' } },
  { name: 'a profile that is not text', plan: { profile: 7, account: 'work' } },
  { name: 'an account that is not text', plan: { profile: 'chatgpt', account: { label: 'work' } } },
  { name: 'no profile', plan: { account: 'work' } },
];

const guardedPlans = async (
  plan: Record<string, unknown>,
): Promise<{ classified: Record<string, unknown>; errorEvent: Record<string, unknown>; failed: Record<string, unknown>; gatewayError: Record<string, unknown> }> => {
  const body = { type: 'too_many_requests', code: 'plan_usage_limit', message: 'limit', param: null, plan };
  const inner = baseAdapter({
    classify: () => ({ retryable: false, error: body }) as unknown as ClassifiedError,
    create: () =>
      eventsOf([
        { type: 'error', sequence_number: 3, error: body } as unknown as StreamEvent,
        failedEvent({ code: 'plan_usage_limit', type: 'too_many_requests', message: 'limit', param: null, plan }),
      ]),
  });
  const guard = guardAdapter(inner, redactor, REASONING_ORIGIN_CODEC);
  const [errorEvent, failed] = await collect(guard.create(REQUEST, ctx()));
  const throwing = guardAdapter(
    baseAdapter({
      capabilities: async () => {
        throw new GatewayError({ status: 429, type: 'too_many_requests', code: 'plan_usage_limit', param: 'p'.repeat(200), message: 'limit', plan: plan as unknown as { profile: string } });
      },
    }),
    redactor,
    REASONING_ORIGIN_CODEC,
  );
  const thrown = await throwing.capabilities(TARGET).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(thrown instanceof GatewayError)) throw new Error('expected the guard to pass a GatewayError');
  return {
    gatewayError: thrown.body as unknown as Record<string, unknown>,
    classified: guard.classify(new Error('x')).error as unknown as Record<string, unknown>,
    errorEvent: (errorEvent as unknown as { error: Record<string, unknown> }).error,
    failed: (failed as unknown as { response: { error: Record<string, unknown> } }).response.error,
  };
};

describe('guardAdapter keeps plan on an error only when its profile and account have the label shape (K3)', () => {
  it.for(MATCHING_PLANS)('keeps $name unchanged on a classified body, an error event and a response.failed error', async ({ plan }) => {
    const guarded = await guardedPlans(plan);
    expect(guarded.classified).toEqual({ type: 'too_many_requests', code: 'plan_usage_limit', message: 'limit', param: null, plan });
    expect(guarded.errorEvent).toEqual({ type: 'too_many_requests', code: 'plan_usage_limit', message: 'limit', param: null, plan });
    expect(guarded.failed).toEqual({ code: 'plan_usage_limit', type: 'too_many_requests', message: 'limit', param: null, plan });
    expect(guarded.gatewayError).toEqual({ type: 'too_many_requests', code: 'plan_usage_limit', message: 'limit', param: null, plan });
  });

  it.for(REFUSED_PLANS)('drops plan with $name from a GatewayError passing the guard', async ({ plan }) => {
    const { gatewayError } = await guardedPlans(plan);
    expect(gatewayError).not.toHaveProperty('plan');
    expect(gatewayError).toEqual({ type: 'too_many_requests', code: 'plan_usage_limit', message: 'limit', param: null });
  });

  it.for(REFUSED_PLANS)('drops plan with $name from a classified body', async ({ plan }) => {
    const { classified } = await guardedPlans(plan);
    expect(classified).not.toHaveProperty('plan');
    expect(classified).toEqual({ type: 'too_many_requests', code: 'plan_usage_limit', message: 'limit', param: null });
  });

  it.for(REFUSED_PLANS)('drops plan with $name from an error event', async ({ plan }) => {
    const { errorEvent } = await guardedPlans(plan);
    expect(errorEvent).not.toHaveProperty('plan');
    expect(errorEvent).toEqual({ type: 'too_many_requests', code: 'plan_usage_limit', message: 'limit', param: null });
  });

  it.for(REFUSED_PLANS)('drops plan with $name from a response.failed error', async ({ plan }) => {
    const { failed } = await guardedPlans(plan);
    expect(failed).not.toHaveProperty('plan');
    expect(failed).toEqual({ code: 'plan_usage_limit', type: 'too_many_requests', message: 'limit', param: null });
  });

  it.for([
    { name: 'a profile and an account', plan: { profile: 'chatgpt', account: 'work', extra: 'leaked-extra' }, kept: { profile: 'chatgpt', account: 'work' } },
    { name: 'a profile and no account', plan: { profile: 'chatgpt', nested: { account: 'leaked-extra' } }, kept: { profile: 'chatgpt' } },
  ])('a plan with $name and a key beyond the two comes out of every site as exactly the two', async ({ plan, kept }) => {
    const guarded = await guardedPlans(plan);
    expect(guarded.classified['plan']).toEqual(kept);
    expect(guarded.errorEvent['plan']).toEqual(kept);
    expect(guarded.failed['plan']).toEqual(kept);
    expect(guarded.gatewayError['plan']).toEqual(kept);
  });
});

describe('guardAdapter passes the served account of its adapter through the one reference guard (N-PLAN-2)', () => {
  const servedBy = (served: unknown): unknown =>
    guardAdapter(baseAdapter({ servedAccount: () => served as { profile: string } }), redactor, REASONING_ORIGIN_CODEC).servedAccount?.(TARGET);

  it('keeps a reference whose labels match, with its two keys only, and the profile-only form', () => {
    expect(servedBy({ profile: 'chatgpt', account: 'work', token: 'x' })).toEqual({ profile: 'chatgpt', account: 'work' });
    expect(servedBy({ profile: 'chatgpt' })).toEqual({ profile: 'chatgpt' });
  });

  it('names no account when the adapter names none or one whose label is outside the pattern', () => {
    expect(servedBy(undefined)).toBeUndefined();
    expect(servedBy({ profile: 'chat/gpt', account: 'work' })).toBeUndefined();
    expect(servedBy({ profile: 'chatgpt', account: 'wo rk' })).toBeUndefined();
  });
});
