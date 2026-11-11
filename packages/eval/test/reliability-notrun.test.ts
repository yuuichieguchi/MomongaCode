import { describe, expect, it } from 'vitest';
import { compareReliability } from '@momonga/eval';
import { aggregate, buildReliabilityReport } from '@momonga/reliability';
import type { ReliabilityReport } from '@momonga/reliability';

const rows = (met: number) => Array.from({ length: 12 }, (_, index) => ({ task: `task-${index}`, trials: 3, met, difficulty: 'easy', taskType: 'bug_fix' }));
const scenarios = () => Array.from({ length: 12 }, (_, index) => ({ scenario: `scenario-${index}`, trials: 3, episodes: 3, recovered: 3 }));

const harness = (codeDigest: string) => ({ suite: { name: 'fixture', digest: 'a'.repeat(64) }, answeredBy: [{ target: 'real/model', adapter: 'anthropic', upstreamModel: 'claude', answers: 'model' as const }], unrecordedAnswers: 0, codeDigest });

const benchmark = (codeDigest: string, notRun: { id: string; reason: string }[] = []): ReliabilityReport =>
  buildReliabilityReport({
    kind: 'benchmark',
    aggregate: aggregate([], { groupBy: 'model' }),
    harness: harness(codeDigest),
    tasks: rows(3),
    cost: { total: { successful: { tasks: 0, fullyPriced: 0, calls: 0, notPriced: 0, tokens: 0, priced: [] }, unsuccessful: { tasks: 0, fullyPriced: 0, calls: 0, notPriced: 0, tokens: 0, priced: [] } }, groups: {} },
    notRun,
  });

const injection = (codeDigest: string, notRun: { id: string; reason: string }[] = []): ReliabilityReport =>
  buildReliabilityReport({ kind: 'injection', aggregate: aggregate([], { groupBy: 'model' }), harness: { ...harness(codeDigest), answeredBy: [{ target: 'scripted', answers: 'script' }] }, scenarios: scenarios(), witnessed: { k: 0, n: 12 }, notRun });

describe('a unit that could not run fails the gate that reads its report (DECISION-5)', () => {
  it('a benchmark candidate with a trial not run fails the gate and names it', () => {
    const comparison = compareReliability(benchmark('b'.repeat(64)), benchmark('c'.repeat(64), [{ id: 'task task-1 trial 0', reason: 'its setup did not exit 0' }]), { seed: 1 });
    expect(comparison.gate.passed).toBe(false);
    expect(comparison.gate.checks).toContainEqual(expect.objectContaining({ name: 'notRun', passed: false, detail: expect.stringContaining('task task-1 trial 0') }));
  });

  it('an injection baseline with a scenario not run fails the gate', () => {
    const comparison = compareReliability(injection('b'.repeat(64), [{ id: 'disk-full', reason: 'needs the Linux container' }]), injection('c'.repeat(64)), { seed: 1 });
    expect(comparison.gate.passed).toBe(false);
    expect(comparison.gate.checks).toContainEqual(expect.objectContaining({ name: 'notRun', passed: false }));
  });

  it('reports where every unit ran pass the not-run term', () => {
    const comparison = compareReliability(benchmark('b'.repeat(64)), benchmark('c'.repeat(64)), { seed: 1 });
    expect(comparison.gate.checks).toContainEqual(expect.objectContaining({ name: 'notRun', passed: true }));
  });
});
