import { describe, expect, it } from 'vitest';
import { measureJsonMode } from '../src/probe/json-mode.ts';

describe('the JSON-only mode step keeps the errors of a step that cannot run', () => {
  it('fails the measurement with a programming error of the step', async () => {
    const broken = new TypeError('cannot read the reply of the step');
    await expect(measureJsonMode(() => Promise.reject(broken))).rejects.toBe(broken);
  });

  it('records the refusal of the model as refused and an unusable answer as unmeasured', async () => {
    expect(await measureJsonMode(async () => ({ kind: 'unsupported' }))).toBe('refused');
    expect(await measureJsonMode(async () => ({ kind: 'failure' }))).toBe('unmeasured');
  });
});
