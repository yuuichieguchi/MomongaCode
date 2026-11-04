import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVENT_TYPES, RUN_API_SCHEMAS, USAGE_CHARGE_PURPOSES } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';

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

const REJECTED = { type: 'model.rejected', step: 1, attempt: 1, reason: 'counter_mismatch', counter: 'b'.repeat(64), meterCounter: 'a'.repeat(64) } as const;

const CHARGED = { type: 'usage.charged', purpose: 'rejected_answer', inputTokens: 300, outputTokens: 7, totalTokens: 307, responseId: 'resp_rejected' } as const;

describe('model.rejected', () => {
  it('is an event type of the run journal with step, attempt, reason, counter and meterCounter', () => {
    const payload: RunEventPayload = REJECTED;
    expect(payload.type).toBe('model.rejected');
    expect(EVENT_TYPES).toContain('model.rejected');
    expectTypeOf<Extract<RunEventPayload, { type: 'model.rejected' }>>().toEqualTypeOf<{
      type: 'model.rejected';
      step: number;
      attempt: number;
      reason: 'counter_mismatch';
      counter: string;
      meterCounter: string;
    }>();
  });

  it('has a closed public schema', () => {
    expect(accepts({ ...ENVELOPE, ...REJECTED })).toBe(true);
    expect(accepts({ ...ENVELOPE, ...REJECTED, reason: 'other' })).toBe(false);
    expect(accepts({ ...ENVELOPE, ...REJECTED, extra: 1 })).toBe(false);
    for (const field of ['attempt', 'reason', 'counter', 'meterCounter']) {
      const partial: Record<string, unknown> = { ...ENVELOPE, ...REJECTED };
      delete partial[field];
      expect(accepts(partial), field).toBe(false);
    }
  });
});

describe('the charge purpose rejected_answer', () => {
  it('is a usage charge purpose that the public schema accepts', () => {
    expect(USAGE_CHARGE_PURPOSES).toContain('rejected_answer');
    expect(accepts({ ...ENVELOPE, ...CHARGED })).toBe(true);
  });
});
