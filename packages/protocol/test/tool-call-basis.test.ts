import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { APPROVAL_BASES, RUN_API_SCHEMAS } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
const acceptsEvent = ajv.compile(RUN_API_SCHEMAS.PublicRunEvent);

const STARTED = { id: 7, runId: 'r1', sessionId: 's1', seq: 4, step: 1, createdAt: 1_800_000_000_000, type: 'tool.started', callId: 'c1', idemKey: 'k1' };

describe('tool.started declares the basis of the approval', () => {
  it('lists the six bases of the design', () => {
    expect(APPROVAL_BASES).toEqual(['read_only', 'rule', 'mode', 'hook', 'classifier', 'person']);
  });

  it.each(APPROVAL_BASES)('accepts the basis %s', (basis) => {
    expect(acceptsEvent({ ...STARTED, basis })).toBe(true);
  });

  it('rejects a basis outside the enum', () => {
    expect(acceptsEvent({ ...STARTED, basis: 'trusted' })).toBe(false);
  });

  it('accepts an event recorded before the basis existed', () => {
    expect(acceptsEvent(STARTED)).toBe(true);
  });
});
