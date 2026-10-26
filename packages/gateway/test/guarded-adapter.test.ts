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
import { ClientDisconnectedError, GatewayError, missingApiKeyError, runCancelledError } from '../src/core/errors.ts';
import { GuardedAdapterError, guardAdapter } from '../src/core/guarded-adapter.ts';
import { createRedactor } from '../src/core/redaction.ts';
import type { TargetRuntime } from '../src/core/router.ts';
import { REDACTED, TEST_API_KEY, expectRedacted } from './credential-support.ts';

const redactor = createRedactor({ credentials: [TEST_API_KEY] });
const TARGET: AdapterTarget = { name: 'primary', model: 'scripted-primary' };
const ctx = (): AdapterContext => ({ signal: new AbortController().signal, target: TARGET, attempt: 1 });
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
  capabilities: async () => DEFAULT_SCRIPTED_CAPABILITIES,
  create: () => eventsOf([]),
  classify: (error) => classifiedOf(error instanceof Error ? error.message : String(error), 'adapter_error'),
  ...overrides,
});

const optionalImplementations = (record: (member: string, self: unknown) => void): Required<Pick<ProviderAdapter, OptionalMember>> => ({
  countTokens: async function (this: unknown) {
    record('countTokens', this);
    return { input_tokens: 3, method: 'estimated', error_bound: 1 };
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
    const guard = guardAdapter(baseAdapter(), redactor);
    for (const member of OPTIONAL_MEMBERS) expect(guard[member]).toBeUndefined();
  });

  it('defines every optional member when the inner adapter has all of them', () => {
    const guard = guardAdapter(baseAdapter(optionalImplementations(() => undefined)), redactor);
    for (const member of OPTIONAL_MEMBERS) expect(typeof guard[member]).toBe('function');
  });

  it.for(OPTIONAL_MEMBERS)('defines only %s when the inner adapter has only that member', (member) => {
    const all = optionalImplementations(() => undefined);
    const guard = guardAdapter(baseAdapter({ [member]: all[member] }), redactor);
    for (const other of OPTIONAL_MEMBERS) {
      if (other === member) expect(typeof guard[other]).toBe('function');
      else expect(guard[other]).toBeUndefined();
    }
  });

  it('passes kind through and delegates close (G5)', async () => {
    let closed = 0;
    const guard = guardAdapter(baseAdapter({ close: async () => void (closed += 1) }), redactor);
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
      capabilities: async function (this: unknown) {
        record('capabilities', this);
        return DEFAULT_SCRIPTED_CAPABILITIES;
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
    const guard = guardAdapter(inner, redactor);
    await guard.capabilities.call(guard, TARGET);
    for await (const _event of guard.create.call(guard, REQUEST, ctx())) void _event;
    guard.classify.call(guard, new Error('plain'));
    await guard.countTokens?.call(guard, { model: 'fast', input: 'one' }, ctx());
    guard.renderWire?.call(guard, REQUEST, TARGET);
    await guard.compact?.call(guard, COMPACT_REQUEST, ctx());
    guard.renderCompactWire?.call(guard, COMPACT_REQUEST, TARGET, 64);
    await guard.health?.call(guard, TARGET);
    expect([...seen.keys()].sort()).toEqual(
      ['capabilities', 'classify', 'compact', 'countTokens', 'create', 'health', 'renderCompactWire', 'renderWire'].sort(),
    );
    for (const self of seen.values()) expect(self).toBe(inner);
  });
});

describe('guardAdapter classify (G1)', () => {
  it('redacts the message and keeps type, code, param, retryable and retryAfterMs', () => {
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf(ECHO, 'invalid_api_key', 'input[0]') }), redactor);
    expect(guard.classify(new Error('x'))).toEqual({
      retryable: false,
      retryAfterMs: 1500,
      error: { type: 'invalid_request', code: 'invalid_api_key', message: REDACTED_ECHO, param: 'input[0]' },
    });
  });

  it('caps the classified message at 1024 characters', () => {
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf('z'.repeat(5000)) }), redactor);
    expect(guard.classify(new Error('x')).error.message.length).toBeLessThanOrEqual(1024);
  });

  it.for([
    { label: 'a known code', code: 'context_length_exceeded', expected: 'context_length_exceeded' },
    { label: 'a code of 64 characters', code: 'c'.repeat(64), expected: 'c'.repeat(64) },
    { label: 'a code with dots, colons and dashes', code: 'upstream.v1:bad-request', expected: 'upstream.v1:bad-request' },
    { label: 'a code of 65 characters', code: 'c'.repeat(65), expected: null },
    { label: 'a code of 70 characters', code: 'c'.repeat(70), expected: null },
    { label: 'a code with a space', code: 'bad code', expected: null },
    { label: 'an empty code', code: '', expected: null },
    { label: 'a code with a slash', code: 'a/b', expected: null },
    { label: 'a null code', code: null, expected: null },
    { label: 'a code equal to the configured key', code: TEST_API_KEY, expected: null },
  ])('maps $label to the code shape check result', ({ code, expected }) => {
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf('plain', code) }), redactor);
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
    const guard = guardAdapter(baseAdapter({ classify: () => classifiedOf('plain', 'invalid_body', param) }), redactor);
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
      redactor,
    );
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
  it('rebuilds a response.failed error with a redacted message, shape-checked code and param, and no extra fields', async () => {
    const inner = baseAdapter({
      create: () => eventsOf([failedEvent({ code: 'bad code', type: 'server_error', message: ECHO, extra: TEST_API_KEY, param: 'p'.repeat(200) })]),
    });
    const [event] = await collect(guardAdapter(inner, redactor).create(REQUEST, ctx()));
    const error = (event as { response: { error: unknown } }).response.error;
    expect(error).toEqual({ code: null, type: 'server_error', message: REDACTED_ECHO, param: null });
  });

  it('keeps a valid response.failed code and param', async () => {
    const inner = baseAdapter({
      create: () => eventsOf([failedEvent({ code: 'context_length_exceeded', type: 'invalid_request', message: 'too long', param: 'input[0].encrypted_content' })]),
    });
    const [event] = await collect(guardAdapter(inner, redactor).create(REQUEST, ctx()));
    expect((event as { response: { error: unknown } }).response.error).toEqual({
      code: 'context_length_exceeded',
      type: 'invalid_request',
      message: 'too long',
      param: 'input[0].encrypted_content',
    });
  });

  it('redacts an error event message and shape-checks its code and param', async () => {
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
    const [event] = await collect(guardAdapter(inner, redactor).create(REQUEST, ctx()));
    expect(event).toEqual({ type: 'error', sequence_number: 3, error: { message: `boom ${REDACTED}`, type: 'server_error', code: null, param: null } });
  });

  it('nulls a response.failed code and an error event code and param equal to the configured key', async () => {
    const inner = baseAdapter({
      create: () =>
        eventsOf([
          { type: 'error', sequence_number: 3, error: { message: 'hiccup', type: 'server_error', code: TEST_API_KEY, param: TEST_API_KEY } },
          failedEvent({ code: TEST_API_KEY, type: 'server_error', message: 'failed', param: TEST_API_KEY }),
        ]),
    });
    const [errorEvent, failed] = await collect(guardAdapter(inner, redactor).create(REQUEST, ctx()));
    expect((errorEvent as { error: unknown }).error).toEqual({ message: 'hiccup', type: 'server_error', code: null, param: null });
    expect((failed as { response: { error: unknown } }).response.error).toEqual({ code: null, type: 'server_error', message: 'failed', param: null });
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
    const events = await collect(guardAdapter(baseAdapter({ create: () => eventsOf([delta]) }), redactor).create(REQUEST, ctx()));
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
    const guard = guardAdapter(baseAdapter({ create: () => failingIterable(failing) }), redactor);
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
    { name: 'renderWire', call: (guard) => guard.renderWire?.(REQUEST, TARGET) },
    { name: 'renderCompactWire', call: (guard) => guard.renderCompactWire?.(COMPACT_REQUEST, TARGET, 64) },
  ];

  it.for(callers)('$name turns an unknown error into a redacted GuardedAdapterError with no cause', async ({ call }) => {
    const original = new Error(`boom ${TEST_API_KEY}`, { cause: new Error(TEST_API_KEY) });
    const error = await rejectionOf(() => call(guardAdapter(throwing(original), redactor)));
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
    const error = await rejectionOf(() => call(guardAdapter(throwing(original), redactor)));
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
    const error = await rejectionOf(() => guardAdapter(throwing(original), redactor).capabilities(TARGET));
    expect(error).toBe(original);
  });

  it('nulls a GatewayError param of 200 characters', async () => {
    const original = new GatewayError({ status: 400, type: 'invalid_request', code: 'invalid_body', param: 'p'.repeat(200), message: 'bad body' });
    const error = (await rejectionOf(() => guardAdapter(throwing(original), redactor).capabilities(TARGET))) as GatewayError;
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.status).toBe(400);
    expect(error.body).toEqual({ type: 'invalid_request', code: 'invalid_body', param: null, message: 'bad body' });
  });

  it('nulls a GatewayError code and param equal to the configured key', async () => {
    const original = new GatewayError({ status: 400, type: 'invalid_request', code: TEST_API_KEY, param: TEST_API_KEY, message: 'bad body' });
    const error = (await rejectionOf(() => guardAdapter(throwing(original), redactor).capabilities(TARGET))) as GatewayError;
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.status).toBe(400);
    expect(error.body).toEqual({ type: 'invalid_request', code: null, param: null, message: 'bad body' });
  });

  it('nulls a GatewayError code that fails the shape check', async () => {
    const original = new GatewayError({ status: 400, type: 'invalid_request', code: 'bad code', param: null, message: 'bad body' });
    const error = (await rejectionOf(() => guardAdapter(throwing(original), redactor).capabilities(TARGET))) as GatewayError;
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.body.code).toBeNull();
  });

  it('rethrows a ClientDisconnectedError unchanged', async () => {
    const original = new ClientDisconnectedError();
    const error = await rejectionOf(() => collect(guardAdapter(throwing(original), redactor).create(REQUEST, ctx())));
    expect(error).toBe(original);
  });
});

describe('guardAdapter health (G4)', () => {
  it('redacts detail and remediation', async () => {
    const guard = guardAdapter(
      baseAdapter({ health: async () => ({ ok: false, reason: 'precondition_failed', detail: `license ${TEST_API_KEY}`, remediation: `run ${TEST_API_KEY}` }) }),
      redactor,
    );
    expect(await guard.health?.(TARGET)).toEqual({ ok: false, reason: 'precondition_failed', detail: `license ${REDACTED}`, remediation: `run ${REDACTED}` });
  });

  it('turns a throwing health check into health_check_failed with a redacted detail', async () => {
    const guard = guardAdapter(
      baseAdapter({
        health: async () => {
          throw new Error(`probe ${TEST_API_KEY}`);
        },
      }),
      redactor,
    );
    expect(await guard.health?.(TARGET)).toEqual({ ok: false, reason: 'health_check_failed', detail: `probe ${REDACTED}` });
  });

  it('passes a healthy result through', async () => {
    const guard = guardAdapter(baseAdapter({ health: async () => ({ ok: true }) }), redactor);
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
