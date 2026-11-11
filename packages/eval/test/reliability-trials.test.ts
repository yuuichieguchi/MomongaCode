import { describe, expect, it } from 'vitest';
import { compareReliability } from '@momonga/eval';
import { aggregate, buildReliabilityReport } from '@momonga/reliability';
import type { ReliabilityReport } from '@momonga/reliability';

const benchmark = (codeDigest: string, trialsOfFirst: number): ReliabilityReport =>
  buildReliabilityReport({
    kind: 'benchmark',
    aggregate: aggregate([], { groupBy: 'model' }),
    harness: { suite: { name: 'fixture', digest: 'a'.repeat(64) }, answeredBy: [{ target: 'real/model', adapter: 'anthropic', upstreamModel: 'claude', answers: 'model' }], unrecordedAnswers: 0, codeDigest },
    tasks: Array.from({ length: 12 }, (_, index) => ({ task: `task-${index}`, trials: index === 0 ? trialsOfFirst : 3, met: 1, difficulty: 'easy', taskType: 'bug_fix' })),
    cost: { total: { successful: { tasks: 0, fullyPriced: 0, calls: 0, notPriced: 0, tokens: 0, priced: [] }, unsuccessful: { tasks: 0, fullyPriced: 0, calls: 0, notPriced: 0, tokens: 0, priced: [] } }, groups: {} },
    notRun: [],
  });

describe('a paired comparison compares units of equal size', () => {
  it('refuses two benchmark reports whose trial counts of a task differ, naming the task', () => {
    expect(() => compareReliability(benchmark('b'.repeat(64), 3), benchmark('c'.repeat(64), 5), { seed: 1 })).toThrow(/task task-0 has 3 trials in the baseline report and 5 in the candidate report/);
  });

  it('compares two benchmark reports whose trial counts agree', () => {
    expect(() => compareReliability(benchmark('b'.repeat(64), 3), benchmark('c'.repeat(64), 3), { seed: 1 })).not.toThrow();
  });
});
