import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, toPublicRunEvent } from '@momonga/protocol';
import type { OpaqueEvent } from '@momonga/protocol';

const schemas = RUN_API_SCHEMAS as unknown as Record<string, Record<string, unknown>>;

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string') ajv.addSchema(schema);

const publicRunEvent = (() => {
  const schema = schemas['PublicRunEvent'];
  if (schema === undefined) throw new Error('RUN_API_SCHEMAS has no PublicRunEvent');
  return ajv.compile(schema);
})();

const accepts = (value: unknown): boolean => publicRunEvent(value) === true;

const RUN_OPAQUE: OpaqueEvent = { opaque: true, type: 'made.up', id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 0, createdAt: 1_800_000_000_000, payload: { type: 'made.up', detail: 'x' } };

const SESSION_OPAQUE: OpaqueEvent = { opaque: true, type: 'session.made.up', id: 8, runId: null, sessionId: 'sess-1', seq: null, step: null, createdAt: 1_800_000_000_000, payload: { detail: 'x' } };

describe('an opaque event on the public stream (H7, 11.4)', () => {
  it('passes the stored type and payload through, under the opaque marker', () => {
    expect(toPublicRunEvent(RUN_OPAQUE)).toEqual({ opaque: true, type: 'made.up', id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 0, createdAt: 1_800_000_000_000, payload: { type: 'made.up', detail: 'x' } });
    expect(toPublicRunEvent(SESSION_OPAQUE)).toEqual({ opaque: true, type: 'session.made.up', id: 8, sessionId: 'sess-1', createdAt: 1_800_000_000_000, payload: { detail: 'x' } });
  });

  it('is accepted by PublicRunEvent only with the marker, an unknown type and a payload', () => {
    expect(accepts(toPublicRunEvent(RUN_OPAQUE))).toBe(true);
    expect(accepts(toPublicRunEvent(SESSION_OPAQUE))).toBe(true);
    const { opaque: _opaque, ...unmarked } = toPublicRunEvent(RUN_OPAQUE) as Record<string, unknown>;
    expect(accepts(unmarked)).toBe(false);
    expect(accepts({ ...(toPublicRunEvent(RUN_OPAQUE) as Record<string, unknown>), type: 'notice' })).toBe(false);
    const { payload: _payload, ...bare } = toPublicRunEvent(RUN_OPAQUE) as Record<string, unknown>;
    expect(accepts(bare)).toBe(false);
  });
});
