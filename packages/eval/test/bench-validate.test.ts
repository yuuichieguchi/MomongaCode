import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATE_NAMES } from '@momonga/eval';
import { ADD_FIXED, ADD_TEST, CHEATING_TEST, benchmarkDir, exported, nodeProbe } from './bench-fixtures.ts';
import type { WorkspaceProbe } from './bench-fixtures.ts';

type Validation = { tasks: { id: string; problems: string[] }[] };

const validate = (file: string, probe: WorkspaceProbe): Promise<Validation> =>
  exported<(benchmarkFile: string, probe: WorkspaceProbe) => Promise<Validation>>('validateBenchmark')(file, probe);

const problemsOf = async (dir: string): Promise<Record<string, string[]>> =>
  Object.fromEntries((await validate(path.join(dir, 'benchmark.json'), nodeProbe)).tasks.map((task) => [task.id, task.problems]));

describe('momonga-bench/1', () => {
  it('parses a benchmark of this format and refuses another format by name', () => {
    const parse = exported<(text: string, source: string) => { format: string; tasks: unknown[] }>('parseBenchmark');
    const text = JSON.stringify({ format: 'momonga-bench/1', name: 'empty', repositories: {}, tasks: [] });
    expect(parse(text, 'b.json')).toMatchObject({ format: 'momonga-bench/1', tasks: [] });
    expect(() => parse(JSON.stringify({ format: 'momonga-bench/0', name: 'old', repositories: {}, tasks: [] }), 'old.json')).toThrow(/momonga-bench\/0/);
  });

  it('names the reliability gate', () => {
    expect([...GATE_NAMES]).toContain('reliability');
  });
});

describe('momonga eval bench --validate (3.4)', () => {
  it('accepts a task that fails on the initial repository and passes with its reference', async () => {
    const dir = await benchmarkDir([{ id: 'valid', reference: { 'src/add.js': ADD_FIXED } }]);
    expect(await problemsOf(dir)).toEqual({ valid: [] });
  });

  it('rejects a task already passing on the initial repository', async () => {
    const dir = await benchmarkDir([{ id: 'solved', repository: { 'src/add.js': ADD_FIXED, 'test/add.test.js': ADD_TEST }, reference: { 'src/add.js': ADD_FIXED } }]);
    expect(await problemsOf(dir)).toEqual({ solved: ['already_passing'] });
  });

  it('rejects an unsolvable task whose reference does not pass', async () => {
    const dir = await benchmarkDir([{ id: 'unsolvable', reference: { 'src/add.js': 'exports.add = () => 0;\n' } }]);
    expect(await problemsOf(dir)).toEqual({ unsolvable: ['unsolvable'] });
  });

  it('a reference that edits a path in unchangedPaths fails that check, so editing the tests to pass fails the task', async () => {
    const dir = await benchmarkDir([{ id: 'cheat', reference: { 'test/add.test.js': CHEATING_TEST } }]);
    expect(await problemsOf(dir)).toEqual({ cheat: ['unsolvable'] });
  });

  it('rejects a graderFiles path that exists in the repository', async () => {
    const dir = await benchmarkDir([{ id: 'visible', reference: { 'src/add.js': ADD_FIXED }, graderFiles: { 'test/add.test.js': ADD_TEST } }]);
    expect((await problemsOf(dir))['visible']).toContain('grader_file_in_repository');
  });

  it('rejects a repository whose digest does not match the file', async () => {
    const dir = await benchmarkDir([{ id: 'drifted', reference: { 'src/add.js': ADD_FIXED }, digest: `sha256:${'0'.repeat(64)}` }]);
    expect((await problemsOf(dir))['drifted']).toContain('digest_mismatch');
  });

  it('accepts graderFiles absent from the repository and leaves the repository without them', async () => {
    const hidden = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add.js');\ntest('hidden', () => assert.strictEqual(add(-1, 1), 0));\n";
    const dir = await benchmarkDir([{ id: 'hidden', reference: { 'src/add.js': ADD_FIXED }, graderFiles: { 'test/hidden.test.js': hidden } }]);
    expect(await problemsOf(dir)).toEqual({ hidden: [] });
    expect(fs.existsSync(path.join(dir, 'repos', 'hidden', 'test', 'hidden.test.js'))).toBe(false);
  });
});
