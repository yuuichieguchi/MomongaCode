import { describe, expect, it } from 'vitest';
import { holdsEntry } from './fixtures.ts';
import type { ManifestEntry } from './manifest-reader.ts';
import { coldRunPlanOf } from './tier-budget.ts';

const row = (config: string, budgetCpuSeconds: number): ManifestEntry => ({ ...holdsEntry, config, tier: 'deep', budgetCpuSeconds });

const unbudgeted = (config: string): ManifestEntry => ({ ...row(config, 1), budgetCpuSeconds: undefined as unknown as number });

describe('the CPU budget of a tier run', () => {
  const entries = [row('A', 5), row('B', 7), row('C', 11)];

  it('sums the budgets of the rows that will run cold', async () => {
    const plan = await coldRunPlanOf({ entries, isReusable: async () => false });
    expect(plan).toEqual({ budgetCpuSeconds: 23, cold: ['A', 'B', 'C'] });
  });

  it('adds nothing for a row whose record is reused', async () => {
    const plan = await coldRunPlanOf({ entries, isReusable: async (entry) => entry.config === 'A' });
    expect(plan).toEqual({ budgetCpuSeconds: 18, cold: ['B', 'C'] });
  });

  it('refuses at start a row that will run and has no CPU budget, naming the row', async () => {
    await expect(coldRunPlanOf({ entries: [row('A', 5), unbudgeted('B')], isReusable: async () => false })).rejects.toThrow('run-lock: no CPU budget for B');
  });

  it('does not refuse a row without a budget when its record is reused', async () => {
    const plan = await coldRunPlanOf({ entries: [unbudgeted('B')], isReusable: async () => true });
    expect(plan).toEqual({ budgetCpuSeconds: 0, cold: [] });
  });
});
