import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileRuleBlocks, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { createSeatbeltSandbox } from '@momonga/sandbox';
import type { SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup } from '@momonga/testkit';
import { PARITY_CANDIDATES, PARITY_SPECS } from '../../policy/test/parity-table.ts';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe.runIf(process.platform === 'darwin')('kernel parity with the exact matcher under real Seatbelt', () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
      spawned = [];
    }
  });

  it.each(PARITY_SPECS.map((row) => [row.specifier]))('Read(%s): the kernel denies exactly what the exact matcher denies on ASCII names', async (specifier) => {
    const base = fs.realpathSync(makeTempDir());
    created.push(base);
    const roots = PARITY_CANDIDATES.map((_candidate, index) => path.join(base, `case-${index}`));
    PARITY_CANDIDATES.forEach((candidate, index) => {
      const target = path.join(roots[index] as string, candidate);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'C');
    });
    const fileRules = fileRulesOf([fileSpec(specifier, { roots, home: path.join(base, 'home') })], roots);
    const targets = PARITY_CANDIDATES.map((candidate, index) => path.join(roots[index] as string, candidate));
    const exact = targets.map((target) => fileRules.entries.some((entry) => fileRuleBlocks(fileRules, entry, target, target)));
    const tmpRoot = path.join(base, 'spawn-tmp');
    fs.mkdirSync(tmpRoot);
    const policy = { writableRoots: [], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], readDenied: [], network: 'deny', fileRules } as SandboxPolicy;
    const proc = createSeatbeltSandbox({ tmpRoot, killGraceMs: 300 }).spawn(
      {
        argv: ['/bin/sh', '-c', 'for f in "$@"; do if cat -- "$f" >/dev/null 2>&1; then echo R; else echo D; fi; done', 'sh', ...targets],
        cwd: base,
        env: { PATH: '/usr/bin:/bin' },
      },
      policy,
      new AbortController().signal,
    );
    spawned.push(proc);
    const result = await run(proc);
    const kernel = result.stdout.trim().split('\n').map((verdict) => verdict === 'D');
    expect(Object.fromEntries(PARITY_CANDIDATES.map((candidate, index) => [candidate, kernel[index]]))).toEqual(
      Object.fromEntries(PARITY_CANDIDATES.map((candidate, index) => [candidate, exact[index]])),
    );
    expect(exact.some(Boolean)).toBe(true);
  });

  it('Read(a[à-ÿ]b): the kernel denies NFD aéb and aæb and leaves the ASCII name aeb readable', async () => {
    const base = fs.realpathSync(makeTempDir());
    created.push(base);
    const root = path.join(base, 'root');
    fs.mkdirSync(root);
    const candidates = ['aeb', 'ae\u0301b', 'a\u00e6b'];
    const targets = candidates.map((candidate) => path.join(root, candidate));
    for (const target of targets) fs.writeFileSync(target, 'C');
    expect(fs.readdirSync(root).sort()).toEqual([...candidates].sort());
    const fileRules = fileRulesOf([fileSpec('a[à-ÿ]b', { roots: [root], home: path.join(base, 'home') })], [root]);
    const exact = targets.map((target) => fileRules.entries.some((entry) => fileRuleBlocks(fileRules, entry, target, target)));
    expect(exact).toEqual([false, true, true]);
    const tmpRoot = path.join(base, 'spawn-tmp');
    fs.mkdirSync(tmpRoot);
    const policy = { writableRoots: [], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], readDenied: [], network: 'deny', fileRules } as SandboxPolicy;
    const proc = createSeatbeltSandbox({ tmpRoot, killGraceMs: 300 }).spawn(
      {
        argv: ['/bin/sh', '-c', 'for f in "$@"; do if cat -- "$f" >/dev/null 2>&1; then echo R; else echo D; fi; done', 'sh', ...targets],
        cwd: base,
        env: { PATH: '/usr/bin:/bin' },
      },
      policy,
      new AbortController().signal,
    );
    spawned.push(proc);
    const result = await run(proc);
    expect(result.stdout.trim().split('\n')).toEqual(['R', 'D', 'D']);
  });
});
