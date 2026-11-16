import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';
import { approvableForms, permittedPsStatuses } from './read-only-forms.ts';
import { HAS_REAL_SANDBOX } from './read-only-support.ts';
import { FORMS, OTHER_PLATFORM, READ_ONLY_SHARDS, readOnlyHarness, shardOf } from './read-only-matrix-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SHARD_CALL = /^readOnlyMatrixShard\((\d+)\);$/m;

describe('the shards of the read-only matrix', () => {
  it('hold every form of this platform exactly once', () => {
    const shards = Array.from({ length: READ_ONLY_SHARDS }, (_unused, index) => shardOf(FORMS, index, READ_ONLY_SHARDS));
    expect(shards.flat().sort()).toEqual([...FORMS].sort());
    expect(shards.every((shard) => shard.length > 0)).toBe(true);
  });

  it('are run by one file each', () => {
    const indexes = fs
      .readdirSync(import.meta.dirname)
      .filter((name) => /^read-only-matrix-\d+\.test\.ts$/.test(name))
      .flatMap((name) => SHARD_CALL.exec(fs.readFileSync(`${import.meta.dirname}/${name}`, 'utf8'))?.[1] ?? [])
      .map(Number)
      .sort((left, right) => left - right);
    expect(indexes).toEqual(Array.from({ length: READ_ONLY_SHARDS }, (_unused, index) => index));
  });
});

describe.runIf(HAS_REAL_SANDBOX)('every approvable command form prints the same under the read-only sandbox', () => {
  const harness = readOnlyHarness();

  it('the generator covers the spec tables', () => {
    expect(FORMS.length).toBeGreaterThan(1000);
    for (const expected of ['sort tracked', 'ls --color=1 tracked', 'git log -1 --oneline', 'git status --short', 'grep -c one tracked']) expect(FORMS.filter((form) => form.startsWith(expected.split(' ').slice(0, 2).join(' '))).length).toBeGreaterThan(0);
  });

  it('generates the forms of the Darwin table and of the GNU table, and ps only from the GNU one', () => {
    const darwin = approvableForms('darwin');
    const linux = approvableForms('linux');
    expect(darwin.length).toBeGreaterThan(1000);
    expect(linux.length).toBeGreaterThan(1000);
    expect(darwin.some((form) => /^ps( |$)/.test(form))).toBe(false);
    expect(linux.some((form) => /^ps( |$)/.test(form))).toBe(true);
    for (const expected of ['git branch --list', 'git tag --list', 'git remote -v', 'git reflog show']) {
      expect(darwin.some((form) => form.startsWith(expected))).toBe(true);
      expect(linux.some((form) => form.startsWith(expected))).toBe(true);
    }
  });

  it.each(approvableForms(OTHER_PLATFORM))(`%s is approved on the ${OTHER_PLATFORM} table, which runs on its own platform`, async (command) => {
    const decision = await harness.decideOn(command, createPolicyFilesystem(OTHER_PLATFORM));
    expect(decision.kind).toBe('allow');
    expect(decision.basis).toBe('read_only');
  });

  it.runIf(process.platform === 'linux')('ps inside the sandbox lists only the sandbox own processes, so its output cannot match the host', async () => {
    const outside = harness.runPlain('ps -e -o pid=').stdout.trim().split('\n').length;
    const result = await harness.sandboxed('echo "SHELL=$$"; ps -e -o pid=');
    expect(result.status).toBe(0);
    const [shellLine, ...listed] = result.stdout.trim().split('\n');
    const shellPid = (shellLine as string).replace('SHELL=', '').trim();
    const inside = listed.map((line) => line.trim());
    expect(inside.length).toBeGreaterThan(0);
    expect(inside).toContain(shellPid);
    expect(outside).toBeGreaterThan(inside.length);
    expect(inside.length).toBeLessThanOrEqual(4);
  });

  it('the status rule of a ps form can fail: a ps form that selects nothing may exit 1, every other must exit 0', () => {
    expect(permittedPsStatuses('ps -e')).toEqual([0]);
    expect(permittedPsStatuses('ps -g 1')).toEqual([0, 1]);
    expect(permittedPsStatuses('ps -N')).toEqual([0, 1]);
  });
});
