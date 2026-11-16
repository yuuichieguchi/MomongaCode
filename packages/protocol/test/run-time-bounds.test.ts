import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANDATE_BUDGET_SCHEMA, MAX_APPROVAL_TTL_MS, MAX_MANDATE_TIME_MS, MAX_RUN_TIMEOUT_MS } from '../src/index.ts';

const RUN_API = path.join(import.meta.dirname, '../src/run-api.ts');

describe('the time bounds of a run are one constant', () => {
  it('bounds the mandate budget time and the approval lifetime by the run timeout bound', () => {
    expect(MAX_MANDATE_TIME_MS).toBe(MAX_RUN_TIMEOUT_MS);
    expect(MAX_APPROVAL_TTL_MS).toBe(MAX_RUN_TIMEOUT_MS);
    expect(MANDATE_BUDGET_SCHEMA).toMatchObject({ properties: { timeMs: { maximum: MAX_MANDATE_TIME_MS } } });
  });

  it('writes the seven days once', () => {
    const source = fs.readFileSync(RUN_API, 'utf8');
    expect(source.match(/7 \* DAY_MS/g)).toHaveLength(1);
  });
});
