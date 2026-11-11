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
import * as protocol from '@momonga/protocol';
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

  it('is public with the attempt, the disposition code, the retry instant and the attempt limit only', () => {
    const failed = { ...ENVELOPE, type: 'attempt.failed', attempt: 2, code: 'gateway_unavailable', retryAt: 1_800_000_030_000, limit: 20 };
    expect(accepts('PublicRunEvent', failed)).toBe(true);
    const { retryAt: _retryAt, ...withoutRetryAt } = failed;
    const { limit: _limit, ...withoutLimit } = failed;
    const { attempt: _attempt, ...withoutAttempt } = failed;
    expect(accepts('PublicRunEvent', withoutAttempt)).toBe(false);
    expect(accepts('PublicRunEvent', withoutRetryAt)).toBe(false);
    expect(accepts('PublicRunEvent', withoutLimit)).toBe(false);
    expect(accepts('PublicRunEvent', { ...failed, retryAt: 'soon' })).toBe(false);
    expect(accepts('PublicRunEvent', { ...failed, limit: 2.5 })).toBe(false);
    expect(accepts('PublicRunEvent', { ...ENVELOPE, type: 'attempt.failed', attempt: 2, retryAt: 1_800_000_030_000, limit: 20 })).toBe(false);
    expect(accepts('PublicRunEvent', { ...failed, message: 'connection refused by 10.0.0.1' })).toBe(false);
  });

  it('projects to the public event without the lease token, keeping the retry instant and the limit', () => {
    const event = { ...ENVELOPE, leaseToken: 4, type: 'attempt.failed', attempt: 3, code: 'stream_interrupted', retryAt: 1_800_000_060_000, limit: 20 } as RunEvent;
    const projected = toPublicRunEvent(event);
    expect(projected).toEqual({ ...ENVELOPE, type: 'attempt.failed', attempt: 3, code: 'stream_interrupted', retryAt: 1_800_000_060_000, limit: 20 });
    expect(accepts('PublicRunEvent', projected)).toBe(true);
  });
});

describe('attempt.lost', () => {
  it('is an event type of the protocol', () => {
    expect(EVENT_TYPES).toContain('attempt.lost');
  });

  it('is public with the last live instant only', () => {
    const lost = { ...ENVELOPE, type: 'attempt.lost', lastLiveAt: 1_800_000_000_500 };
    expect(accepts('PublicRunEvent', lost)).toBe(true);
    expect(accepts('PublicRunEvent', { ...ENVELOPE, type: 'attempt.lost' })).toBe(false);
    expect(accepts('PublicRunEvent', { ...lost, workerId: 'worker-1' })).toBe(false);
  });

  it('round-trips through the public projection without the lease token', () => {
    const event = { ...ENVELOPE, leaseToken: 4, type: 'attempt.lost', lastLiveAt: 1_800_000_000_100 } as unknown as RunEvent;
    const projected = toPublicRunEvent(event);
    expect(projected).toEqual({ ...ENVELOPE, type: 'attempt.lost', lastLiveAt: 1_800_000_000_100 });
    expect(accepts('PublicRunEvent', projected)).toBe(true);
  });
});

describe('run.started carries no recovery field', () => {
  const started = { ...ENVELOPE, type: 'run.started', attempt: 2 };

  it('accepts the attempt alone and refuses a recovery field', () => {
    expect(accepts('PublicRunEvent', started)).toBe(true);
    expect(accepts('PublicRunEvent', { ...started, recovery: { cause: 'process_lost', failedAt: 1_800_000_000_500 } })).toBe(false);
  });

  it('projects run.started to the attempt alone, dropping pins and now', () => {
    const event = { ...ENVELOPE, leaseToken: 4, type: 'run.started', attempt: 2, now: 1_800_000_000_900, pins: { model: 'apple/fm-model' } } as RunEvent;
    expect(toPublicRunEvent(event)).toEqual({ ...ENVELOPE, type: 'run.started', attempt: 2 });
  });
});

describe('protocol/src/reliability.ts', () => {
  it('pins the constants of section 8', () => {
    expect(MIN_RATE_POPULATION).toBe(35);
    expect(REPORT_PAGE_ROWS).toBe(500);
    expect(FACTS_SWEEP_BATCH_RUNS).toBe(3);
    expect(INDICATOR_DEFINITIONS_VERSION).toBe(5);
    expect(RELIABILITY_FORMAT).toBe('momonga-reliability/6');
  });

  it('names the two recovery causes and the four episode outcomes', () => {
    expect([...RECOVERY_CAUSES]).toEqual(['worker_failure', 'process_lost']);
    expect([...RECOVERY_OUTCOMES]).toEqual(['recovered', 'unknown_effect', 'failed', 'stopped']);
  });

  it('bounds a facts page by REPORT_PAGE_ROWS', () => {
    const schema = schemas['ReportPage'];
    expect(schema, 'RUN_API_SCHEMAS has ReportPage').toBeDefined();
    expect(schema?.['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const rows = (schema?.['properties'] as Record<string, Record<string, unknown>> | undefined)?.['rows'];
    expect(rows?.['maxItems']).toBe(REPORT_PAGE_ROWS);
    expect(accepts('ReportPage', { rows: [], unavailable: [], nextCursor: null })).toBe(true);
    expect(accepts('ReportPage', { rows: [], unavailable: [{ runId: 'r', rootRunId: 'r' }], nextCursor: null })).toBe(true);
    expect(accepts('ReportPage', { rows: [], nextCursor: null })).toBe(false);
    expect(accepts('ReportPage', { rows: [] })).toBe(false);
  });
});

describe('protocol/src/trace-attributes.ts', () => {
  it('holds the span attribute names shared by the writers and the cli reader', () => {
    expect(MOMONGA_ATTRIBUTES).toEqual({
      runId: 'momonga.run_id',
      step: 'momonga.step',
      attempt: 'momonga.attempt',
      retryOf: 'momonga.retry_of',
      billing: 'momonga.billing',
      usageSource: 'momonga.usage_source',
      target: 'momonga.target',
      role: 'momonga.role',
      failureMessage: 'momonga.failure_message',
      fallbackCauses: 'momonga.fallback_causes',
      route: 'momonga.route',
      errorCode: 'momonga.error_code',
      routeProxy: 'momonga.route.proxy',
      toolBackendSource: 'tool.backend.source',
      toolBackendVersion: 'tool.backend.version',
    });
    expect(ERROR_TYPE_ATTRIBUTE).toBe('error.type');
  });
});

describe('decisions 54 and 57', () => {
  it('draws 73 observations per rate denominator for the review sample', () => {
    expect((protocol as Record<string, unknown>)['REVIEW_SAMPLE_SIZE']).toBe(73);
  });
});
