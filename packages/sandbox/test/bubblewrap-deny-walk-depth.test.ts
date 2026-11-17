import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { nodeFilesystemPort, planBubblewrap } from '@momonga/sandbox';
import type { FilesystemPort, SandboxPolicy } from '@momonga/sandbox';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir } from './helpers.ts';
import { NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';

const TREE_DEPTH = 50;

let base = '';
let work = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, ...Array.from({ length: TREE_DEPTH }, (_, index) => `d${index}`)), { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const depthOf = (directory: string): number => directory.split('/').filter((part) => part !== '').length;

describe('the walk for blocked paths under a deny pattern without a globstar', () => {
  it('lists no folder deeper than the pattern can reach, whatever the depth of the tree', async () => {
    const listed: string[] = [];
    const inner = nodeFilesystemPort(testKernelLock());
    const port: FilesystemPort = {
      ...inner,
      children: async (directory) => {
        listed.push(directory);
        return await inner.children(directory);
      },
    };
    const policy: SandboxPolicy = {
      writableRoots: [work],
      writeDenied: [],
      writeDeniedLiterals: [],
      protectedSet: EMPTY_PROTECTED_SET,
      fileRules: await fileRulesOf([fileSpec(`/${path.join(work, '*.env')}`, { roots: [work], home: base, tool: 'Read' })], [work]),
      readDenied: [],
      network: 'deny',
    };

    await planBubblewrap(policy, { cwd: work }, NEVER_CANCELLED, port);

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((directory) => depthOf(directory) <= depthOf(work))).toBe(true);
  });
});
