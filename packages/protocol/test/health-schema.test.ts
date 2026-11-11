import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS } from '@momonga/protocol';
import type { RunHealth } from '@momonga/protocol';

const validate = new Ajv2020.default({ strict: true, allErrors: true }).compile(RUN_API_SCHEMAS.Health);

const PRODUCED: RunHealth = {
  status: 'ok',
  version: '0.0.0',
  apiVersion: 1,
  pid: 4242,
  startedAt: '2027-01-15T08:00:00.000Z',
  state: 'running',
  role: 'serving',
  steps: 0,
  jobs: 0,
  sandbox: 'seatbelt',
};

describe('the health reply: every field the producer always sends is required', () => {
  it('accepts the reply the producer sends', () => {
    expect(validate(PRODUCED)).toBe(true);
  });

  it.each(['role', 'steps', 'jobs'] as const)('refuses a reply without %s', (field) => {
    const { [field]: _omitted, ...missing } = PRODUCED;
    expect(validate(missing)).toBe(false);
  });

  it('requires every property the schema declares', () => {
    const schema = RUN_API_SCHEMAS.Health as { properties: Record<string, unknown>; required: string[] };
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it('types role, steps and jobs as always present', () => {
    const role: 'starting' | 'serving' | 'retiring' = PRODUCED.role;
    const work: number = PRODUCED.steps + PRODUCED.jobs;
    expect([role, work]).toEqual(['serving', 0]);
  });
});
