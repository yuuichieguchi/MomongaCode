import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVENT_TYPES, RUN_API_SCHEMAS, TARGET_PROBE_FAILED, toPublicRunEvent } from '@momonga/protocol';
import type { HookEvent, RunEvent, RunEventPayload } from '@momonga/protocol';

const schemas = RUN_API_SCHEMAS as unknown as Record<string, Record<string, unknown>>;

const publicEvent = (): ValidateFunction => {
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string') ajv.addSchema(schema);
  const schema = schemas['PublicRunEvent'];
  if (schema === undefined) throw new Error('RUN_API_SCHEMAS has no PublicRunEvent');
  return typeof schema['$id'] === 'string' ? (ajv.getSchema(schema['$id']) as ValidateFunction) : ajv.compile(schema);
};

const accepts = (value: unknown): boolean => publicEvent()(value) === true;

const ENVELOPE = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 1, createdAt: 1_800_000_000_000 };

const COMPACTING = { type: 'context.compacting', step: 1, attempt: 1 } as const;
const CLASSIFYING = { type: 'tool.permission.classifying', callId: 'call-1', subjectDigest: 'd'.repeat(64) } as const;
const HOOK_STARTED = { type: 'hook.started', event: 'PreToolUse', command: 'echo checked', callId: 'call-1' } as const;

const withoutField = (payload: Record<string, unknown>, field: string): Record<string, unknown> => {
  const partial: Record<string, unknown> = { ...ENVELOPE, ...payload };
  delete partial[field];
  return partial;
};

describe('the run events that back the waiting row (design-screens 6.1.1)', () => {
  it('are event types of the run journal with the fields of the design', () => {
    const payloads: RunEventPayload[] = [COMPACTING, CLASSIFYING, HOOK_STARTED];
    expect(payloads.map((payload) => payload.type)).toEqual(['context.compacting', 'tool.permission.classifying', 'hook.started']);
    for (const payload of payloads) expect(EVENT_TYPES).toContain(payload.type);
    expectTypeOf<Extract<RunEventPayload, { type: 'context.compacting' }>>().toEqualTypeOf<{ type: 'context.compacting'; step: number; attempt: number }>();
    expectTypeOf<Extract<RunEventPayload, { type: 'tool.permission.classifying' }>>().toEqualTypeOf<{ type: 'tool.permission.classifying'; callId: string; subjectDigest: string }>();
    expectTypeOf<Extract<RunEventPayload, { type: 'hook.started' }>['event']>().toEqualTypeOf<HookEvent>();
    expectTypeOf<Extract<RunEventPayload, { type: 'hook.started' }>['command']>().toEqualTypeOf<string>();
    expectTypeOf<Extract<RunEventPayload, { type: 'hook.started' }>['callId']>().toEqualTypeOf<string | undefined>();
  });

  it('context.compacting has a closed public schema that requires attempt', () => {
    expect(accepts({ ...ENVELOPE, ...COMPACTING })).toBe(true);
    expect(accepts({ ...ENVELOPE, ...COMPACTING, extra: 1 })).toBe(false);
    expect(accepts(withoutField(COMPACTING, 'attempt'))).toBe(false);
    expect(accepts({ ...ENVELOPE, ...COMPACTING, attempt: 'one' })).toBe(false);
  });

  it('tool.permission.classifying has a closed public schema that requires callId and subjectDigest', () => {
    expect(accepts({ ...ENVELOPE, ...CLASSIFYING })).toBe(true);
    expect(accepts({ ...ENVELOPE, ...CLASSIFYING, extra: 1 })).toBe(false);
    for (const field of ['callId', 'subjectDigest']) expect(accepts(withoutField(CLASSIFYING, field)), field).toBe(false);
  });

  it('hook.started has a closed public schema that requires event and command and takes callId', () => {
    expect(accepts({ ...ENVELOPE, ...HOOK_STARTED })).toBe(true);
    expect(accepts(withoutField(HOOK_STARTED, 'callId'))).toBe(true);
    expect(accepts({ ...ENVELOPE, ...HOOK_STARTED, extra: 1 })).toBe(false);
    expect(accepts({ ...ENVELOPE, ...HOOK_STARTED, event: 'NotAHookEvent' })).toBe(false);
    for (const field of ['event', 'command']) expect(accepts(withoutField(HOOK_STARTED, field)), field).toBe(false);
  });

  it.each([COMPACTING, CLASSIFYING, HOOK_STARTED])('the public mapping passes $type to clients with every field and without the lease token', (payload) => {
    const stored = { ...payload, ...ENVELOPE, leaseToken: 4 } as RunEvent;
    const visible = toPublicRunEvent(stored);
    expect(visible).toEqual({ ...payload, ...ENVELOPE });
    expect(accepts(visible)).toBe(true);
  });
});

describe('the code of a failed measurement', () => {
  it('is target_probe_failed', () => {
    expect(TARGET_PROBE_FAILED).toBe('target_probe_failed');
  });
});
