import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { createSeatbeltSandbox, createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

const variants: Array<[string, (tmpRoot: string) => Sandbox]> = [
  ['seatbelt', (tmpRoot) => createSeatbeltSandbox({ tmpRoot, killGraceMs: 300 })],
  ['unsandboxed', () => createUnsandboxed({ killGraceMs: 300 })],
];

describe.runIf(process.platform === 'darwin').each(variants)('stdin (%s)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, (_kind, make) => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let root = '';
  let sandbox: Sandbox;

  const policy = (): SandboxPolicy => ({
    writableRoots: [root],
    writeDenied: [],
    protectedSet: EMPTY_PROTECTED_SET,
    writeDeniedLiterals: [],
    fileRules: EMPTY_FILE_RULES,
    readDenied: [],
    network: 'deny',
  });

  const sh = async (script: string, stdin: string | undefined): Promise<SandboxedProcess> => {
    const proc = await sandbox.spawn(
      { argv: ['/bin/sh', '-c', script], cwd: root, env: BASE_ENV, ...(stdin === undefined ? {} : { stdin }) },
      policy(),
      new AbortController().signal,
    );
    spawned.push(proc);
    return proc;
  };

  beforeEach(() => {
    root = fs.realpathSync(makeTempDir());
    created.push(root);
    const tmpRoot = fs.realpathSync(makeTempDir());
    created.push(tmpRoot);
    sandbox = make(tmpRoot);
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
      spawned = [];
    }
  });

  it('delivers the given text to the child and closes the stream', async () => {
    const result = await run(await sh('cat', '{"hook":"input"}'));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"hook":"input"}');
  });

  it('gives a child that never reads stdin an exit instead of a broken pipe failure', async () => {
    const result = await run(await sh('exit 3', 'x'.repeat(1_000_000)));
    expect(result.code).toBe(3);
  });

  it('leaves stdin closed when no text is given', async () => {
    const result = await run(await sh('cat', undefined));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });
});
