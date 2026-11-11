import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { OPERATION_EFFECT_OUTCOMES, RUN_API_SCHEMAS } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
const acceptsEvent = ajv.compile(RUN_API_SCHEMAS.PublicRunEvent);

const ENVELOPE = { id: 7, runId: 'r1', sessionId: 's1', seq: 4, step: 1, createdAt: 1_800_000_000_000 };
const COMPLETED = { ...ENVELOPE, type: 'tool.completed', callId: 'c1', status: 'completed', output: 'pushed' };
const RECONCILED = { ...ENVELOPE, type: 'tool.reconciled', callId: 'c1', outcome: 'already_applied', output: 'pushed' };

describe('tool.completed and tool.reconciled carry the observed effect of an operation', () => {
  it('has the four outcomes of an effect', () => {
    expect(OPERATION_EFFECT_OUTCOMES).toEqual(['applied', 'already_applied', 'failed', 'unknown']);
  });

  it.each(OPERATION_EFFECT_OUTCOMES)('accepts the outcome %s on both events', (outcome) => {
    const effect = { operation: 'GitPush', target: 'feature/x', outcome };
    expect(acceptsEvent({ ...COMPLETED, effect })).toBe(true);
    expect(acceptsEvent({ ...RECONCILED, effect })).toBe(true);
  });

  it('rejects an effect without its target, with an outcome outside the enum, or with a field it does not know', () => {
    expect(acceptsEvent({ ...COMPLETED, effect: { operation: 'GitPush', outcome: 'applied' } })).toBe(false);
    expect(acceptsEvent({ ...COMPLETED, effect: { operation: 'GitPush', target: 'x', outcome: 'done' } })).toBe(false);
    expect(acceptsEvent({ ...RECONCILED, effect: { operation: 'GitPush', target: 'x', outcome: 'applied', credential: 'x' } })).toBe(false);
  });

  it('accepts both events without an effect, as every tool that is not an operation records them', () => {
    expect(acceptsEvent(COMPLETED)).toBe(true);
    expect(acceptsEvent(RECONCILED)).toBe(true);
  });
});
