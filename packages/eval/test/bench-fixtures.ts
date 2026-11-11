import { spawnSync } from '@momonga/testkit/child-process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import * as evaluation from '@momonga/eval';
import { nodeWorkspaceFiles } from '@momonga/eval';
import type { WorkspaceFiles } from '@momonga/eval';

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

export const exported = <T>(name: string): T => {
  const value = (evaluation as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@momonga/eval does not export ${name}`);
  return value as T;
};

export type WorkspaceProbe = {
  run(command: string, timeoutMs: number, cwd: string): Promise<{ exitCode: number | null; timedOut: boolean }>;
  digest(cwd: string, paths: readonly string[]): Promise<string>;
  changedPaths(cwd: string, baseDir: string): Promise<string[]>;
};

const filesUnder = (dir: string, prefix = ''): string[] =>
  fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(dir, relative) : [relative];
  });

const contentOf = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

export const nodeProbe: WorkspaceProbe = {
  run: async (command, timeoutMs, cwd) => {
    const result = spawnSync('/bin/sh', ['-c', command], { cwd, timeout: timeoutMs, stdio: 'ignore' });
    return { exitCode: result.status, timedOut: result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' };
  },
  digest: async (cwd, paths) => {
    const hash = crypto.createHash('sha256');
    for (const relative of [...paths].sort()) hash.update(`${relative}\0${contentOf(path.join(cwd, relative)) ?? '\u0001absent'}\0`);
    return hash.digest('hex');
  },
  changedPaths: async (cwd, baseDir) => {
    const all = new Set([...filesUnder(cwd), ...filesUnder(baseDir)]);
    return [...all].filter((relative) => contentOf(path.join(cwd, relative)) !== contentOf(path.join(baseDir, relative))).sort();
  },
};

export const ADD_BUGGY = 'exports.add = (a, b) => a - b;\n';
export const ADD_FIXED = 'exports.add = (a, b) => a + b;\n';
export const ADD_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add.js');\ntest('adds', () => assert.strictEqual(add(2, 3), 5));\n";
export const CHEATING_TEST = "const test = require('node:test');\ntest('adds', () => {});\n";

const write = (root: string, files: Record<string, string>): void => {
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
};

export type FixtureTask = {
  id: string;
  repository?: Record<string, string>;
  reference: Record<string, string>;
  graderFiles?: Record<string, string>;
  digest?: string;
};

export const benchmarkDir = async (tasks: readonly FixtureTask[]): Promise<string> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bench-'));
  cleanups.push(dir);
  const treeDigest = exported<(files: WorkspaceFiles, directory: string) => Promise<string>>('treeDigest');
  const repositories: Record<string, { directory: string; digest: string }> = {};
  for (const task of tasks) {
    write(path.join(dir, 'repos', task.id), task.repository ?? { 'src/add.js': ADD_BUGGY, 'test/add.test.js': ADD_TEST });
    write(path.join(dir, 'solutions', task.id), task.reference);
    repositories[task.id] = { directory: `repos/${task.id}`, digest: task.digest ?? (await treeDigest(nodeWorkspaceFiles, path.join(dir, 'repos', task.id))) };
  }
  const benchmark = {
    format: 'momonga-bench/1',
    name: 'fixture',
    repositories,
    tasks: tasks.map((task) => ({
      id: task.id,
      repository: task.id,
      taskType: 'bug_fix',
      difficulty: 'easy',
      labelledBy: 'fixture',
      labelledAt: '2026-11-06',
      prompt: 'Fix add.',
      permissionMode: 'acceptEdits',
      onAsk: 'allow_once',
      budget: { maxSteps: 10, maxTotalTokens: 100000, timeoutMs: 60000 },
      runs: 3,
      setup: [],
      graderFiles: task.graderFiles ?? {},
      declaration: [],
      oracle: [
        { id: 'tests', kind: 'command', run: 'node --test', expectExit: 0, evidence: 'unit', timeoutMs: 30000 },
        { id: 'tests-untouched', kind: 'unchangedPaths', paths: ['test/add.test.js'] },
        { id: 'scope', kind: 'changedPathsWithin', paths: ['src/', 'test/'] },
      ],
      reference: { directory: `solutions/${task.id}` },
    })),
  };
  fs.writeFileSync(path.join(dir, 'benchmark.json'), JSON.stringify(benchmark, null, 2));
  return dir;
};
