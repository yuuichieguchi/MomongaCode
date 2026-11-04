import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, RUN_API_SCHEMAS, toPublicRunEvent } from '@momonga/protocol';
import type { RunEvent } from '@momonga/protocol';

const schemas = RUN_API_SCHEMAS as unknown as Record<string, Record<string, unknown>>;

const buildAjv = () => {
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string') ajv.addSchema(schema);
  return ajv;
};

const ajv = buildAjv();

const publicEvent = (): ValidateFunction => {
  const schema = schemas['PublicRunEvent'];
  if (schema === undefined) throw new Error('RUN_API_SCHEMAS has no PublicRunEvent');
  return typeof schema['$id'] === 'string' ? (ajv.getSchema(schema['$id']) as ValidateFunction) : ajv.compile(schema);
};

const accepts = (value: unknown): boolean => publicEvent()(value) === true;

const RUN_ENVELOPE = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 2, createdAt: 1_800_000_000_000 };

const COMPLETED = { ...RUN_ENVELOPE, type: 'tool.completed', callId: 'c1', status: 'completed', output: 'formatted text', handle: 'h'.repeat(64) };

describe('the event types of the token contract', () => {
  it('lists tool.loaded and loop.warned among the event types', () => {
    expect(EVENT_TYPES).toContain('tool.loaded');
    expect(EVENT_TYPES).toContain('loop.warned');
  });
});

describe('tool.loaded in the public event schema', () => {
  it('accepts the names of the loaded tools', () => {
    expect(accepts({ ...RUN_ENVELOPE, type: 'tool.loaded', names: ['Grep', 'Glob'] })).toBe(true);
  });

  it('refuses a load without names, with an empty or non-string name, or with an extra field', () => {
    expect(accepts({ ...RUN_ENVELOPE, type: 'tool.loaded' })).toBe(false);
    expect(accepts({ ...RUN_ENVELOPE, type: 'tool.loaded', names: [] })).toBe(false);
    expect(accepts({ ...RUN_ENVELOPE, type: 'tool.loaded', names: [''] })).toBe(false);
    expect(accepts({ ...RUN_ENVELOPE, type: 'tool.loaded', names: [3] })).toBe(false);
    expect(accepts({ ...RUN_ENVELOPE, type: 'tool.loaded', names: ['Grep'], definitions: [] })).toBe(false);
  });

  it('passes through the public projection without the lease token', () => {
    const event = { ...RUN_ENVELOPE, leaseToken: 4, type: 'tool.loaded', names: ['Grep'] } as unknown as RunEvent;
    const projected = toPublicRunEvent(event);
    expect(projected).toEqual({ ...RUN_ENVELOPE, type: 'tool.loaded', names: ['Grep'] });
    expect(accepts(projected)).toBe(true);
  });
});

describe('loop.warned in the public event schema', () => {
  it('accepts the signature of the repeated call', () => {
    expect(accepts({ ...RUN_ENVELOPE, type: 'loop.warned', signature: 'sig-1' })).toBe(true);
  });

  it('refuses a warning without a signature, with a non-string signature, or with an extra field', () => {
    expect(accepts({ ...RUN_ENVELOPE, type: 'loop.warned' })).toBe(false);
    expect(accepts({ ...RUN_ENVELOPE, type: 'loop.warned', signature: 1 })).toBe(false);
    expect(accepts({ ...RUN_ENVELOPE, type: 'loop.warned', signature: 'sig-1', count: 3 })).toBe(false);
  });

  it('passes through the public projection without the lease token', () => {
    const event = { ...RUN_ENVELOPE, leaseToken: 4, type: 'loop.warned', signature: 'sig-1' } as unknown as RunEvent;
    expect(toPublicRunEvent(event)).toEqual({ ...RUN_ENVELOPE, type: 'loop.warned', signature: 'sig-1' });
  });
});

describe('tool.completed.formatted', () => {
  it('accepts the formatter and its version', () => {
    expect(accepts({ ...COMPLETED, formatted: { formatter: 'log', version: 1 } })).toBe(true);
  });

  it('still accepts a completion without it', () => {
    expect(accepts(COMPLETED)).toBe(true);
  });

  it('refuses a formatted record that misses a field, has a wrong type or carries an extra field', () => {
    expect(accepts({ ...COMPLETED, formatted: { formatter: 'log' } })).toBe(false);
    expect(accepts({ ...COMPLETED, formatted: { version: 1 } })).toBe(false);
    expect(accepts({ ...COMPLETED, formatted: { formatter: 'log', version: 'one' } })).toBe(false);
    expect(accepts({ ...COMPLETED, formatted: { formatter: 'log', version: 1, raw: 'x' } })).toBe(false);
  });
});

describe('context.truncated of kind reference', () => {
  it('accepts the reference kind beside omitted and truncated', () => {
    for (const kind of ['omitted', 'truncated', 'reference']) {
      expect(accepts({ ...RUN_ENVELOPE, type: 'context.truncated', callId: 'c1', handle: 'h'.repeat(64), kind }), kind).toBe(true);
    }
    expect(accepts({ ...RUN_ENVELOPE, type: 'context.truncated', callId: 'c1', handle: 'h'.repeat(64), kind: 'linked' })).toBe(false);
  });
});
