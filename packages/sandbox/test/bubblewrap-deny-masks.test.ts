import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { MASK_ARGUMENT_CEILING, SandboxPolicyError, nodeFilesystemPort, planBubblewrap } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir } from './helpers.ts';
import { NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';

const FULLY_DENIED_FILES = 9200;

let base = '';
let work = '';
let tree = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  tree = path.join(work, 'tree');
  fs.mkdirSync(tree, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const writeFiles = (directory: string, count: number, suffix: string): void => {
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) fs.writeFileSync(path.join(directory, `secret-${index}${suffix}`), 'x');
};

const readDenyPolicy = async (specifiers: readonly string[], overrides: Partial<SandboxPolicy> = {}): Promise<SandboxPolicy> => {
  const specs = specifiers.map((specifier) => fileSpec(specifier, { roots: [work], home: base, tool: 'Read' }));
  return {
    writableRoots: [work],
    writeDenied: [],
    writeDeniedLiterals: [],
    protectedSet: EMPTY_PROTECTED_SET,
    fileRules: specs.length === 0 ? EMPTY_FILE_RULES : await fileRulesOf(specs, [work]),
    readDenied: [],
    network: 'deny',
    ...overrides,
  };
};

const plan = (policy: SandboxPolicy) => planBubblewrap(policy, { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));

const masksOf = (args: readonly string[]) => ({
  tmpfs: args.flatMap((value, index) => (value === '--tmpfs' && args[index + 1] !== '/run' ? [args[index + 1]] : [])),
  devNull: args.flatMap((value, index) => (value === '--ro-bind' && args[index + 1] === '/dev/null' ? [args[index + 2] as string] : [])),
});

describe('the read masks of a deny set', () => {
  it('masks a fully denied directory of 9200 files as one directory', async () => {
    writeFiles(tree, FULLY_DENIED_FILES, '.env');
    const { args } = await plan(await readDenyPolicy(['tree/*.env']));
    const masks = masksOf(args);
    expect(masks.tmpfs).toEqual([tree]);
    expect(masks.devNull).toEqual([]);
    expect(args.length).toBeLessThan(MASK_ARGUMENT_CEILING);
  });

  it('keeps a per-file mask for each denied file when the directory holds an allowed file too', async () => {
    writeFiles(tree, 50, '.env');
    fs.writeFileSync(path.join(tree, 'keep.txt'), 'x');
    const { args } = await plan(await readDenyPolicy(['tree/*.env']));
    const masks = masksOf(args);
    expect(masks.tmpfs).toEqual([]);
    expect(masks.devNull).toHaveLength(50);
    expect(masks.devNull.every((file) => file.endsWith('.env'))).toBe(true);
  });

  it('masks a fully denied subtree and keeps per-file masks in a sibling that has an allowed file', async () => {
    writeFiles(path.join(tree, 'full'), 30, '.env');
    writeFiles(path.join(tree, 'mixed'), 4, '.env');
    fs.writeFileSync(path.join(tree, 'mixed', 'keep.txt'), 'x');
    const { args } = await plan(await readDenyPolicy(['tree/**/*.env']));
    const masks = masksOf(args);
    expect(masks.tmpfs).toEqual([path.join(tree, 'full')]);
    expect(masks.devNull.sort()).toEqual([0, 1, 2, 3].map((index) => path.join(tree, 'mixed', `secret-${index}.env`)).sort());
  });

  it('does not fold a directory that holds the writable root, so the root stays bound writable', async () => {
    writeFiles(work, 20, '.env');
    const { args } = await plan(await readDenyPolicy(['*.env']));
    const masks = masksOf(args);
    expect(masks.tmpfs).not.toContain(work);
    expect(masks.devNull).toHaveLength(20);
  });

  it('remounts a folded directory read-only after its tmpfs, so a write to it fails', async () => {
    writeFiles(tree, 10, '.env');
    const { args } = await plan(await readDenyPolicy(['tree/*.env']));
    const mount = args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === tree);
    const remount = args.findIndex((value, index) => value === '--remount-ro' && args[index + 1] === tree);
    expect(mount).toBeGreaterThan(-1);
    expect(remount).toBeGreaterThan(mount);
  });

  it('refuses a deny set whose masks exceed the ceiling with the typed policy error, before any spawn', async () => {
    fs.writeFileSync(path.join(tree, 'keep.txt'), 'x');
    writeFiles(tree, Math.floor(MASK_ARGUMENT_CEILING / 3) + 1, '.env');
    const error = await plan(await readDenyPolicy(['tree/*.env'])).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect(error).toMatchObject({ code: 'deny_set_exceeds_argument_ceiling' });
    expect((error as Error).message).toContain(String(MASK_ARGUMENT_CEILING));
  });
});
