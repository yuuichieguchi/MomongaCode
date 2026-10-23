import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxPolicy } from '@momonga/tools';
import { createReadAccessMatcher } from '../../src/read-access.ts';
import { makeBuiltins } from './fixtures.ts';

const brokenEntry = (project: string): string => {
  const file = path.join(project, 'plain');
  fs.writeFileSync(file, 'x');
  return path.join(file, 'x');
};

describe('sandbox policy entries that cannot be canonicalised', () => {
  it.each(['writeDenied', 'readDenied'] as const)('reject the batch before any tool runs for a bad %s entry', async (field) => {
    const tools = await makeBuiltins();
    const project = tools.layout.project;
    const sandboxPolicy = { ...tools.sandboxPolicy, [field]: [...tools.sandboxPolicy[field], brokenEntry(project)] };
    const target = path.join(project, 'out.txt');
    await expect(tools.run('Write', { file_path: target, content: 'x' }, { mode: 'acceptEdits', sandboxPolicy })).rejects.toThrow();
    expect(tools.idempotency.log).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('reject a read-only batch for a bad writeDenied entry before any tool runs', async () => {
    const tools = await makeBuiltins();
    const project = tools.layout.project;
    const readable = tools.write('readable.txt', 'content');
    const sandboxPolicy = { ...tools.sandboxPolicy, writeDenied: [...tools.sandboxPolicy.writeDenied, brokenEntry(project)] };
    await expect(tools.run('Read', { file_path: readable }, { sandboxPolicy })).rejects.toThrow();
    expect(tools.idempotency.log).toEqual([]);
  });
});

describe('relative sandbox policy entries', () => {
  const options = (dir: string) => ({ roots: [path.join(dir, 'project')], home: path.join(dir, 'home'), tmpDir: path.join(dir, 'sessions', 's'), sessionsTmpRoot: path.join(dir, 'sessions') });

  it('make buildSandboxPolicy throw for a relative extraReadDenied entry', async () => {
    const tools = await makeBuiltins();
    expect(() => buildSandboxPolicy({ ...options(tools.layout.root), extraReadDenied: ['relative-denied'] })).toThrow(/absolute/);
  });

  it('make buildSandboxPolicy throw for a relative readAllowed entry', async () => {
    const tools = await makeBuiltins();
    expect(() => buildSandboxPolicy({ ...options(tools.layout.root), readAllowed: ['sessions/s/inner'] })).toThrow(/absolute/);
  });

  it('make buildSandboxPolicy throw for a relative extraWritable entry', async () => {
    const tools = await makeBuiltins();
    expect(() => buildSandboxPolicy({ ...options(tools.layout.root), extraWritable: ['relative-writable'] })).toThrow(/absolute/);
  });

  it('make buildSandboxPolicy throw for a relative root', async () => {
    const tools = await makeBuiltins();
    expect(() => buildSandboxPolicy({ ...options(tools.layout.root), roots: ['relative-root'] })).toThrow(/absolute/);
  });

  it('make createReadAccessMatcher throw for a relative readDenied entry', () => {
    expect(() => createReadAccessMatcher({ readDenied: ['relative-denied'] })).toThrow(/absolute/);
  });

  it('make createReadAccessMatcher throw for a relative readAllowed entry', async () => {
    const tools = await makeBuiltins();
    const denied = path.join(tools.layout.root, 'denied');
    fs.mkdirSync(denied);
    const original = process.cwd();
    process.chdir(tools.layout.root);
    try {
      expect(() => createReadAccessMatcher({ readDenied: [denied], readAllowed: ['denied/inner'] })).toThrow(/absolute/);
    } finally {
      process.chdir(original);
    }
  });

  it.each(['readDenied', 'writeDenied', 'writableRoots'] as const)('reject the executor batch for a relative %s entry', async (field) => {
    const tools = await makeBuiltins();
    const sandboxPolicy = { ...tools.sandboxPolicy, [field]: [...tools.sandboxPolicy[field], 'relative-entry'] };
    const target = path.join(tools.layout.project, 'out.txt');
    await expect(tools.run('Write', { file_path: target, content: 'x' }, { mode: 'acceptEdits', sandboxPolicy })).rejects.toThrow(/absolute/);
    expect(tools.idempotency.log).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });
});
