import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { createBubblewrapSandbox, nodeFilesystemPort } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { makeTempDir, run } from './helpers.ts';

const reaper = vi.hoisted(() => ({ failure: undefined as Error | undefined }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...original,
    terminateGroup: (...args: Parameters<typeof original.terminateGroup>) => (reaper.failure === undefined ? original.terminateGroup(...args) : Promise.reject(reaper.failure)),
  };
});

const FAKE_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do
  if [ "$1" = "--ro-bind" ] && [ "$2" = "/dev/null" ] && [ ! -e "$3" ]; then : > "$3"; fi
  shift
done
shift
exec "$@"
`;

let base = '';
let work = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(base, 'tmp'));
  fs.writeFileSync(path.join(base, 'bwrap'), FAKE_BWRAP, { mode: 0o755 });
});

afterEach(() => {
  reaper.failure = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = (writeDenied: string[]): SandboxPolicy => ({
  writableRoots: [work],
  writeDenied,
  writeDeniedLiterals: [],
  readDenied: [],
  network: 'deny',
  fileRules: EMPTY_FILE_RULES,
  protectedSet: EMPTY_PROTECTED_SET,
});

describe('a process group that cannot be reaped', () => {
  it('still removes the placeholder and the private tmp dir, and reports the reap failure', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const sandbox = createBubblewrapSandbox({ bwrapPath: path.join(base, 'bwrap'), tmpRoot: path.join(base, 'tmp'), killGraceMs: 300 });
    reaper.failure = new Error('the group could not be terminated');
    const proc = sandbox.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    await expect(run(proc)).rejects.toBe(reaper.failure);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
    expect(fs.readdirSync(path.join(base, 'tmp'))).toEqual([]);
  });

  it('reports both failures when the reap and the cleanup after it fail', async () => {
    const reapFailure = new Error('the group could not be terminated');
    const cleanupFailure = new Error('the placeholder could not be removed');
    reaper.failure = reapFailure;
    const hooks = path.join(work, '.git', 'hooks');
    const sandbox = createBubblewrapSandbox({
      bwrapPath: path.join(base, 'bwrap'),
      tmpRoot: path.join(base, 'tmp'),
      killGraceMs: 300,
      filesystem: {
        ...nodeFilesystemPort,
        removePlaceholder: () => {
          throw cleanupFailure;
        },
      },
    });
    const proc = sandbox.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    const failure = await run(proc).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([reapFailure, cleanupFailure]);
  });
});
