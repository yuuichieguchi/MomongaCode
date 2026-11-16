import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTempDir } from '@momonga/testkit';
import { nodeProbe } from './bench-fixtures.ts';

const BENCH_DIR = path.resolve(import.meta.dirname, '..', 'datasets', 'bench');

type Declared = { id: string; command: string; when: string };
type ShippedTask = { id: string; repository: string; declaration: Declared[]; reference: { directory: string } };
type Shipped = { repositories: Record<string, { directory: string }>; tasks: ShippedTask[] };

const shipped = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'benchmark.json'), 'utf8')) as Shipped;
const scratch = createTempDir();
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const workspaceOf = (task: ShippedTask, fixed: boolean): string => {
  const repository = shipped.repositories[task.repository];
  if (repository === undefined) throw new Error(`task ${task.id} names no shipped repository`);
  const workspace = path.join(scratch, `${task.id}-${fixed ? 'fixed' : 'broken'}`);
  fs.cpSync(path.join(BENCH_DIR, repository.directory), workspace, { recursive: true });
  if (fixed) fs.cpSync(path.join(BENCH_DIR, task.reference.directory), workspace, { recursive: true });
  return workspace;
};

const passes = async (task: ShippedTask, workspace: string): Promise<boolean> => {
  for (const condition of task.declaration) {
    const outcome = await nodeProbe.run(condition.command, 60_000, workspace);
    if (outcome.timedOut || outcome.exitCode !== 0) return false;
  }
  return true;
};

describe('the declarations of the shipped benchmark tasks (DECISION-6)', () => {
  it('declares every task by its own check, labelled as the task\'s own and checked on every run', () => {
    expect(shipped.tasks).toHaveLength(12);
    for (const task of shipped.tasks) {
      expect(task.declaration.length, task.id).toBeGreaterThan(0);
      for (const condition of task.declaration) {
        expect(condition.id, task.id).toMatch(/^task-own-/);
        expect(condition.when, task.id).toBe('always');
      }
    }
  });

  it.each(shipped.tasks)('the declaration of $id passes on its fixed workspace and fails on its broken one', async (task) => {
    expect(await passes(task, workspaceOf(task, true))).toBe(true);
    expect(await passes(task, workspaceOf(task, false))).toBe(false);
  }, 120_000);
});
