import fs from 'node:fs';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, ruleEnforcementOf } from '@momonga/foundation';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFileRules } from '@momonga/policy';
import { buildSandboxPolicy } from '@momonga/tools';
import { createReadAccessMatcher } from '../../src/read-access.ts';
import { SandboxPolicyError, validateSandboxPolicy } from '@momonga/sandbox';
import { makeBuiltins } from './fixtures.ts';

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxPolicyError);
    return (error as SandboxPolicyError).code;
  }
  return undefined;
};

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
    expect(() => buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, ...options(tools.layout.root), extraReadDenied: ['relative-denied'] })).toThrow(/absolute/);
  });

  it('make buildSandboxPolicy throw for a relative readAllowed entry', async () => {
    const tools = await makeBuiltins();
    expect(() => buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, ...options(tools.layout.root), readAllowed: ['sessions/s/inner'] })).toThrow(/absolute/);
  });

  it('make buildSandboxPolicy throw for a relative extraWritable entry', async () => {
    const tools = await makeBuiltins();
    expect(() => buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, ...options(tools.layout.root), extraWritable: ['relative-writable'] })).toThrow(/absolute/);
  });

  it('make buildSandboxPolicy throw for a relative root', async () => {
    const tools = await makeBuiltins();
    expect(() => buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, ...options(tools.layout.root), roots: ['relative-root'] })).toThrow(/absolute/);
  });

  it.each([
    ['readDenied', 'entry_not_absolute'],
    ['readAllowed', 'entry_not_absolute'],
    ['writeDenied', 'entry_not_absolute'],
    ['writableRoots', 'writable_root_not_absolute'],
  ] as const)('make validateSandboxPolicy, the one validation point, throw for a relative %s entry', async (field, code) => {
    const tools = await makeBuiltins();
    const sandboxPolicy = { ...tools.sandboxPolicy, [field]: [...(tools.sandboxPolicy[field] ?? []), 'relative-entry'] };
    expect(codeOf(() => validateSandboxPolicy(sandboxPolicy, { tmpDir: tools.tmpDir }))).toBe(code);
  });
});

describe('the executor and the read-access matcher trust the validated policy', () => {
  it('createReadAccessMatcher builds a matcher for a readAllowed entry outside every readDenied entry', async () => {
    const tools = await makeBuiltins();
    const denied = path.join(tools.layout.root, 'denied');
    const elsewhere = path.join(tools.layout.root, 'elsewhere');
    fs.mkdirSync(denied);
    fs.mkdirSync(elsewhere);
    const matcher = createReadAccessMatcher({ fileRules: EMPTY_FILE_RULES, readDenied: [denied], readAllowed: [elsewhere] });
    expect(matcher.blocksResolved(path.join(denied, 'x'))).toBe(true);
  });

  it('runBatch runs a batch whose tmpDir is not one of readAllowed', async () => {
    const tools = await makeBuiltins();
    const stray = path.join(tools.layout.root, 'stray-tmp');
    fs.mkdirSync(stray, { mode: 0o700 });
    const target = path.join(tools.layout.project, 'out.txt');
    const outcome = await tools.run('Write', { file_path: target, content: 'x' }, { mode: 'acceptEdits', tmpDir: stray, sandboxPolicy: { ...tools.sandboxPolicy, fileRules: computeFileRules([], [tools.layout.project], stray, ruleEnforcementOf('none')) } });
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });
});
