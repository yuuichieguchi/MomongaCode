import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, toPublicRunEvent } from '@momonga/protocol';
import type { RunEvent } from '@momonga/protocol';

const schemas = RUN_API_SCHEMAS as unknown as Record<string, Record<string, unknown>>;

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string') ajv.addSchema(schema);

const publicRunEvent = (() => {
  const schema = schemas['PublicRunEvent'];
  if (schema === undefined) throw new Error('RUN_API_SCHEMAS has no PublicRunEvent');
  return ajv.compile(schema);
})();

const envelope = { id: 4, runId: 'run-1', sessionId: 'sess-1', seq: 1, step: 0, leaseToken: 1, createdAt: 1_800_000_000_000 };

describe('the /compact request on the public stream', () => {
  it('is accepted with and without instructions', () => {
    const withText: RunEvent = { ...envelope, type: 'user.compact', instructions: 'keep the test names' };
    const plain: RunEvent = { ...envelope, type: 'user.compact' };
    expect(toPublicRunEvent(withText)).toMatchObject({ type: 'user.compact', instructions: 'keep the test names' });
    expect(publicRunEvent(toPublicRunEvent(withText))).toBe(true);
    expect(publicRunEvent(toPublicRunEvent(plain))).toBe(true);
    expect(publicRunEvent({ ...toPublicRunEvent(plain), instructions: 3 })).toBe(false);
  });
});
