import type { RunReport } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { renderReport } from '../../src/commands/report.ts';

const BASE: RunReport = {
  runId: 'run-1',
  status: 'STOPPED',
  stopReason: 'budget',
  durationMs: 1200,
  declaration: null,
  changes: { files: [], mutatingCalls: 0 },
  conditions: [],
  notRun: [],
  residualRisk: [],
  modelChecks: [],
};

describe('a budget stop is said in one sentence, the one the vocabulary gives', () => {
  it.each([
    [{ dimension: 'tokens', cause: 'limit', spent: 100, limit: 100 } as const, 'The run stopped at its token limit (100 of 100 used or reserved).'],
    [{ dimension: 'steps', cause: 'limit', spent: 5, limit: 5 } as const, 'The run stopped at its step limit (5 of 5 used or reserved).'],
    [{ dimension: 'cost', cause: 'unpriced', spent: 0, limit: 1_000_000_000 } as const, 'The run stopped at its money limit: a model call has no price, so its cost cannot be counted (0 USD of 1 USD used or reserved).'],
  ])('says the stop of %j in the vocabulary sentence', (stoppedBy, sentence) => {
    expect(renderReport({ ...BASE, stoppedBy }).split('\n').at(-1)).toBe(sentence);
  });

  it('does not write a second sentence for the same stop', () => {
    const text = renderReport({ ...BASE, stoppedBy: { dimension: 'steps', cause: 'limit', spent: 5, limit: 5 } });
    expect(text).not.toContain('stopped by the');
  });
});
