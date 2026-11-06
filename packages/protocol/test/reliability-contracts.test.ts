import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  ERROR_TYPE_ATTRIBUTE,
  EVENT_TYPES,
  FACTS_SWEEP_BATCH_RUNS,
  INDICATOR_DEFINITIONS_VERSION,
  MIN_RATE_POPULATION,
  MOMONGA_ATTRIBUTES,
  RECOVERY_CAUSES,
  RECOVERY_OUTCOMES,
  RELIABILITY_FORMAT,
  REPORT_PAGE_ROWS,
  RUN_API_SCHEMAS,
  toPublicRunEvent,
} from '@momonga/protocol';
import type { RunEvent } from '@momonga/protocol';

const schemas = RUN_API_SCHEMAS as unknown as Record<string, Record<string, unknown>>;

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string') ajv.addSchema(schema);

const validator = (name: string): ValidateFunction => {
  const schema = schemas[name];
  if (schema === undefined) throw new Error(`RUN_API_SCHEMAS has no ${name}`);
  return typeof schema['$id'] === 'string' ? (ajv.getSchema(schema['$id']) as ValidateFunction) : ajv.compile(schema);
};

const accepts = (name: string, value: unknown): boolean => validator(name)(value) === true;

const ENVELOPE = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 0, createdAt: 1_800_000_000_000 };

describe('attempt.failed', () => {
  it('is an event type of the protocol', () => {
    expect(EVENT_TYPES).toContain('attempt.failed');
  });

  it('is public with the attempt and the disposition code only', () => {
    const failed = { ...ENVELOPE, type: 'attempt.failed', attempt: 2, code: 'gateway_unavailable' };
    expect(accepts('PublicRunEvent', failed)).toBe(true);
    expect(accepts('PublicRunEvent', { ...ENVELOPE, type: 'attempt.failed', attempt: 2 })).toBe(false);
    expect(accepts('PublicRunEvent', { ...ENVELOPE, type: 'attempt.failed', code: 'gateway_unavailable' })).toBe(false);
    expect(accepts('PublicRunEvent', { ...failed, message: 'connection refused by 10.0.0.1' })).toBe(false);
  });

  it('round-trips through the public projection without the lease token', () => {
    const event = { ...ENVELOPE, leaseToken: 4, type: 'attempt.failed', attempt: 3, code: 'stream_interrupted' } as RunEvent;
    const projected = toPublicRunEvent(event);
    expect(projected).toEqual({ ...ENVELOPE, type: 'attempt.failed', attempt: 3, code: 'stream_interrupted' });
    expect(accepts('PublicRunEvent', projected)).toBe(true);
  });
});

describe('run.started.recovery', () => {
  const started = { ...ENVELOPE, type: 'run.started', attempt: 2 };

  it('is accepted in the public run.started for both causes', () => {
    expect(accepts('PublicRunEvent', { ...started, recovery: { cause: 'worker_failure', failedAt: 1_800_000_000_500 } })).toBe(true);
    expect(accepts('PublicRunEvent', { ...started, recovery: { cause: 'process_lost', failedAt: 1_800_000_000_500 } })).toBe(true);
    expect(accepts('PublicRunEvent', started)).toBe(true);
  });

  it('accepts exactly the two causes with a failedAt and nothing else', () => {
    expect(accepts('PublicRunEvent', { ...started, recovery: { cause: 'worker_failure', failedAt: 1 } })).toBe(true);
    expect(accepts('PublicRunEvent', { ...started, recovery: { cause: 'drain', failedAt: 1 } })).toBe(false);
    expect(accepts('PublicRunEvent', { ...started, recovery: { cause: 'worker_failure' } })).toBe(false);
    expect(accepts('PublicRunEvent', { ...started, recovery: { cause: 'worker_failure', failedAt: 1, message: 'x' } })).toBe(false);
  });

  it('keeps recovery and drops pins and now in the public projection', () => {
    const event = {
      ...ENVELOPE,
      leaseToken: 4,
      type: 'run.started',
      attempt: 2,
      now: 1_800_000_000_900,
      pins: { modelAlias: 'fm' },
      recovery: { cause: 'process_lost', failedAt: 1_800_000_000_100 },
    } as RunEvent;
    const projected = toPublicRunEvent(event);
    expect(projected).toEqual({ ...ENVELOPE, type: 'run.started', attempt: 2, recovery: { cause: 'process_lost', failedAt: 1_800_000_000_100 } });
    expect(accepts('PublicRunEvent', projected)).toBe(true);
    const first = { ...ENVELOPE, leaseToken: 4, type: 'run.started', attempt: 1, now: 1, pins: {} } as RunEvent;
    expect(toPublicRunEvent(first)).toEqual({ ...ENVELOPE, type: 'run.started', attempt: 1 });
  });
});

describe('protocol/src/reliability.ts', () => {
  it('pins the constants of section 8', () => {
    expect(MIN_RATE_POPULATION).toBe(35);
    expect(REPORT_PAGE_ROWS).toBe(500);
    expect(FACTS_SWEEP_BATCH_RUNS).toBe(3);
    expect(INDICATOR_DEFINITIONS_VERSION).toBe(1);
    expect(RELIABILITY_FORMAT).toBe('momonga-reliability/1');
  });

  it('names the two recovery causes and the three episode outcomes', () => {
    expect([...RECOVERY_CAUSES]).toEqual(['worker_failure', 'process_lost']);
    expect([...RECOVERY_OUTCOMES]).toEqual(['recovered', 'unknown_effect', 'failed']);
  });

  it('bounds a facts page by REPORT_PAGE_ROWS', () => {
    const schema = schemas['ReportPage'];
    expect(schema, 'RUN_API_SCHEMAS has ReportPage').toBeDefined();
    expect(schema?.['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const rows = (schema?.['properties'] as Record<string, Record<string, unknown>> | undefined)?.['rows'];
    expect(rows?.['maxItems']).toBe(REPORT_PAGE_ROWS);
    expect(accepts('ReportPage', { rows: [], nextCursor: null })).toBe(true);
    expect(accepts('ReportPage', { rows: [] })).toBe(false);
  });
});

describe('protocol/src/trace-attributes.ts', () => {
  it('holds the span attribute names shared by the writers and the cli reader', () => {
    expect(MOMONGA_ATTRIBUTES).toEqual({
      runId: 'momonga.run_id',
      step: 'momonga.step',
      attempt: 'momonga.attempt',
      billing: 'momonga.billing',
      cacheWriteInputTokens: 'momonga.usage.cache_write_input_tokens',
      target: 'momonga.target',
      role: 'momonga.role',
      failureMessage: 'momonga.failure_message',
      fallbackCauses: 'momonga.fallback_causes',
    });
    expect(ERROR_TYPE_ATTRIBUTE).toBe('error.type');
  });
});
