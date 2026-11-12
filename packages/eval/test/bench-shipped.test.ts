import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeWorkspaceFiles } from '@momonga/eval';
import type { WorkspaceFiles } from '@momonga/eval';
import { exported, nodeProbe } from './bench-fixtures.ts';
import type { WorkspaceProbe } from './bench-fixtures.ts';
import { systemTempRoot, testKernelLock } from '@momonga/testkit';
import type { KernelLockMechanism } from '@momonga/foundation';

const BENCH_DIR = path.resolve(import.meta.dirname, '..', 'datasets', 'bench');
const BENCH_FILE = path.join(BENCH_DIR, 'benchmark.json');
const TASK_TYPES = ['bug_fix', 'add_test', 'lint_fix', 'docs_update', 'dependency_update'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

type ShippedTask = { id: string; repository: string; taskType: string; difficulty: string; labelledBy: string; labelledAt: string; runs?: number };
type Shipped = { format: string; repositories: Record<string, { directory: string; digest: string }>; tasks: ShippedTask[] };

const shipped = (): Shipped => JSON.parse(fs.readFileSync(BENCH_FILE, 'utf8')) as Shipped;

describe('the shipped benchmark (3.6, decision 20)', () => {
  it('holds at least 12 labelled tasks across the five task types and the three difficulty labels', () => {
    const benchmark = shipped();
    expect(benchmark.format).toBe('momonga-bench/1');
    expect(benchmark.tasks.length).toBeGreaterThanOrEqual(12);
    expect([...new Set(benchmark.tasks.map((task) => task.taskType))].sort()).toEqual([...TASK_TYPES].sort());
    expect([...new Set(benchmark.tasks.map((task) => task.difficulty))].sort()).toEqual([...DIFFICULTIES].sort());
    for (const task of benchmark.tasks) {
      expect(task.labelledBy, task.id).toBe('Yuuichi');
      expect(task.labelledAt, task.id).toBe('2026-11-06');
    }
  });

  it('uses only fixture repositories vendored inside this repository, under datasets/bench/repos', () => {
    const benchmark = shipped();
    const repos = path.join(BENCH_DIR, 'repos') + path.sep;
    for (const [id, repository] of Object.entries(benchmark.repositories)) {
      const resolved = path.resolve(BENCH_DIR, repository.directory);
      expect(resolved.startsWith(repos), id).toBe(true);
      expect(fs.statSync(resolved).isDirectory(), id).toBe(true);
      expect(repository.directory, id).not.toMatch(/^[a-z]+:\/\//);
    }
    for (const task of benchmark.tasks) expect(Object.keys(benchmark.repositories), task.id).toContain(task.repository);
  });

  it('P12: every shipped task fails on its initial repository and passes with its reference', async () => {
    const validate = exported<(benchmarkFile: string, ports: { probe: WorkspaceProbe; files: WorkspaceFiles; tmpdir: string; lock: KernelLockMechanism }) => Promise<{ tasks: { id: string; problems: string[] }[] }>>('validateBenchmark');
    const result = await validate(BENCH_FILE, { probe: nodeProbe, files: nodeWorkspaceFiles, tmpdir: systemTempRoot(), lock: testKernelLock() });
    expect(result.tasks.map((task) => task.id).sort()).toEqual(shipped().tasks.map((task) => task.id).sort());
    expect(result.tasks.filter((task) => task.problems.length > 0)).toEqual([]);
  }, 600_000);
});
