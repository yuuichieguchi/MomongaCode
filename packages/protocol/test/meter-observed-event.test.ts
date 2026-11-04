import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, RUN_API_SCHEMAS } from '@momonga/protocol';
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

const ENVELOPE = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 2, createdAt: 1_800_000_000_000 };

const OBSERVED = {
  type: 'meter.observed',
  target: 'primary',
  fallback: false,
  inputDigest: 'd'.repeat(64),
  itemCount: 3,
  counted: 250,
  reported: 240,
  kept: 250,
  known: 200,
  uncounted: 50,
  miss: 5,
  contextWindow: 8192,
  tokenErrorRatio: 0.25,
  tokenCounting: 'estimated',
} as const;

describe('meter.observed', () => {
  it('is an event type of the run journal', () => {
    const payload: RunEventPayload = OBSERVED;
    expect(payload.type).toBe('meter.observed');
    expect(EVENT_TYPES).toContain('meter.observed');
  });

  it('has a closed schema that accepts every field, with tokenErrorRatio optional', () => {
    expect(accepts({ ...ENVELOPE, ...OBSERVED })).toBe(true);
    const { tokenErrorRatio: _omitted, ...withoutRatio } = OBSERVED;
    expect(accepts({ ...ENVELOPE, ...withoutRatio })).toBe(true);
  });

  it.each(['target', 'fallback', 'inputDigest', 'itemCount', 'counted', 'reported', 'kept', 'known', 'uncounted', 'miss', 'contextWindow', 'tokenCounting'])(
    'refuses an event without %s',
    (field) => {
      const partial: Record<string, unknown> = { ...ENVELOPE, ...OBSERVED };
      delete partial[field];
      expect(accepts(partial)).toBe(false);
    },
  );

  it('refuses an unknown field, an unknown method, a shape field and a non-integer count', () => {
    expect(accepts({ ...ENVELOPE, ...OBSERVED, extra: 3 })).toBe(false);
    expect(accepts({ ...ENVELOPE, ...OBSERVED, fallback: 'no' })).toBe(false);
    expect(accepts({ ...ENVELOPE, ...OBSERVED, tokenCounting: 'guessed' })).toBe(false);
    expect(accepts({ ...ENVELOPE, ...OBSERVED, shape: { ratio: 0.3, minimum: 1 } })).toBe(false);
    expect(accepts({ ...ENVELOPE, ...OBSERVED, miss: -1 })).toBe(false);
    expect(accepts({ ...ENVELOPE, ...OBSERVED, counted: 2.5 })).toBe(false);
  });
});
