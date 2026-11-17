import { describe, expect, it } from 'vitest';
import { createFileLock } from '@momonga/foundation';
import type { FileLockOps, LockFileIdentity } from '@momonga/foundation';

const LOCK_PATH = '/locks/a.lock';
const DESCRIPTOR = 77;

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

const SAME_FILE = { dev: 1n, ino: 1n };

const scriptedOps = (script: ReadonlyArray<string | number>, named: (opens: number) => LockFileIdentity | undefined = () => SAME_FILE): FileLockOps & { opens: number; closed: number[] } => {
  const ops = {
    opens: 0,
    closed: [] as number[],
    open: (): number => {
      const step = script[ops.opens];
      ops.opens += 1;
      if (step === undefined) throw new Error('the script ran out');
      if (typeof step === 'string') throw errno(step);
      return step;
    },
    close: (descriptor: number): void => {
      ops.closed.push(descriptor);
    },
    fstat: (): LockFileIdentity => SAME_FILE,
    lstat: (): LockFileIdentity | undefined => named(ops.opens),
  };
  return ops;
};

describe('the darwin claim when the holder goes away during the race', () => {
  it('retries the claim when the lock file was unlinked between the refused open and the probe', async () => {
    const ops = scriptedOps(['EAGAIN', 'ENOENT', DESCRIPTOR]);

    const outcome = await createFileLock(ops, 'darwin').claim(LOCK_PATH);

    expect(outcome.kind).toBe('claimed');
    expect(outcome.kind === 'claimed' ? outcome.lock.descriptor : undefined).toBe(DESCRIPTOR);
    expect(ops.opens).toBe(3);
  });

  it('gives up a lock on a file that was unlinked and replaced while the claim was being granted, and claims the new one', async () => {
    const ops = scriptedOps([DESCRIPTOR, DESCRIPTOR + 1], (opens) => (opens === 1 ? { dev: 1n, ino: 2n } : SAME_FILE));

    const outcome = await createFileLock(ops, 'darwin').claim(LOCK_PATH);

    expect(outcome.kind === 'claimed' ? outcome.lock.descriptor : undefined).toBe(DESCRIPTOR + 1);
    expect(ops.closed).toEqual([DESCRIPTOR]);
  });

  it('retries when the path names nothing any more', async () => {
    const ops = scriptedOps([DESCRIPTOR, DESCRIPTOR + 1], (opens) => (opens === 1 ? undefined : SAME_FILE));

    const outcome = await createFileLock(ops, 'darwin').claim(LOCK_PATH);

    expect(outcome.kind === 'claimed' ? outcome.lock.descriptor : undefined).toBe(DESCRIPTOR + 1);
  });

  it('does the same through the synchronous claim used for a hand-off', () => {
    const ops = scriptedOps(['EAGAIN', 'ENOENT', DESCRIPTOR]);

    const claim = createFileLock(ops, 'darwin').claimInheritable;

    expect(claim?.(LOCK_PATH).kind).toBe('claimed');
  });
});
