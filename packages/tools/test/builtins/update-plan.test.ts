import { describe, expect, it } from 'vitest';
import { makeBuiltins, range, resultOf } from './fixtures.ts';

const entry = (content: string, status = 'pending', priority = 'medium') => ({ content, status, priority });

describe('UpdatePlan', () => {
  it('returns the plan unchanged with an entry count', async () => {
    const tools = await makeBuiltins();
    const entries = [entry('write tests', 'completed', 'high'), entry('implement', 'in_progress', 'low')];
    const result = resultOf(await tools.run('UpdatePlan', { entries }, { mode: 'plan' }));
    expect(result).toEqual({ status: 'completed', output: 'Plan updated (2 entries)', plan: entries });
  });

  it('accepts 100 entries and content of 500 characters', async () => {
    const tools = await makeBuiltins();
    const entries = range(1, 100).map((n) => entry(n === 1 ? 'c'.repeat(500) : `step ${n}`));
    const result = resultOf(await tools.run('UpdatePlan', { entries }));
    expect(result).toMatchObject({ status: 'completed', output: 'Plan updated (100 entries)' });
    expect(result.plan).toEqual(entries);
  });

  it.each([
    ['no entries', []],
    ['101 entries', range(1, 101).map((n) => entry(`step ${n}`))],
    ['empty content', [entry('')]],
    ['501 characters', [entry('c'.repeat(501))]],
    ['an unknown status', [entry('x', 'done')]],
    ['an unknown priority', [entry('x', 'pending', 'urgent')]],
    ['an extra property', [{ ...entry('x'), id: 1 }]],
  ])('rejects %s', async (_label, entries) => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('UpdatePlan', { entries }));
    expect(result.status).toBe('failed');
    expect(result.plan).toBeUndefined();
  });
});
