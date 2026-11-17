import { describe, expect, it } from 'vitest';
import { createFileLock } from '@momonga/foundation';
import type { FileLockOps } from '@momonga/foundation';

const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;

const wouldBlock = (): NodeJS.ErrnoException => Object.assign(new Error('EAGAIN: resource temporarily unavailable'), { code: 'EAGAIN' });

type Step = 'exclusive-blocked' | 'exclusive-granted' | 'shared-blocked' | 'shared-granted' | 'shared-missing';

const scriptedOps = (steps: readonly Step[]) => {
  const remaining = [...steps];
  const opened: string[] = [];
  const closed: number[] = [];
  let nextDescriptor = 100;
  const ops: FileLockOps = {
    open: (_lockPath, flags) => {
      const kind = (flags & O_EXLOCK) !== 0 ? 'exclusive' : (flags & O_SHLOCK) !== 0 ? 'shared' : 'plain';
      const step = remaining.shift();
      if (step === undefined) throw new Error(`unscripted ${kind} open`);
      opened.push(`${kind}:${step}`);
      if (!step.startsWith(kind)) throw new Error(`scripted ${step} but the lock mechanism opened ${kind}`);
      if (step.endsWith('blocked')) throw wouldBlock();
      if (step === 'shared-missing') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return nextDescriptor++;
    },
    close: (descriptor) => void closed.push(descriptor),
    fstat: () => ({ dev: 1n, ino: 1n }),
    lstat: () => ({ dev: 1n, ino: 1n }),
  };
  return { ops, opened, closed, exhausted: () => remaining.length === 0 };
};

describe('a claim against a transient shared lock', () => {
  it('retries when the refusal came from a shared lock, because a shared lock proves no exclusive holder exists', async () => {
    const script = scriptedOps(['exclusive-blocked', 'shared-granted', 'exclusive-granted']);
    const outcome = await createFileLock(script.ops, 'darwin').claim('/run/x.lock');
    expect(outcome.kind).toBe('claimed');
    expect(script.opened).toEqual(['exclusive:exclusive-blocked', 'shared:shared-granted', 'exclusive:exclusive-granted']);
    expect(script.closed).toEqual([100]);
    expect(script.exhausted()).toBe(true);
  });

  it('reports held when an exclusive holder refuses the shared lock as well', async () => {
    const script = scriptedOps(['exclusive-blocked', 'shared-blocked']);
    expect((await createFileLock(script.ops, 'darwin').claim('/run/x.lock')).kind).toBe('held');
    expect(script.closed).toEqual([]);
  });

  it('does not map any other failure to held', async () => {
    const failing: FileLockOps = {
      open: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      close: () => undefined,
      fstat: () => ({ dev: 1n, ino: 1n }),
      lstat: () => ({ dev: 1n, ino: 1n }),
    };
    await expect(createFileLock(failing, 'darwin').claim('/run/x.lock')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('keeps the descriptor of a claim open until it is released, once', async () => {
    const script = scriptedOps(['exclusive-granted']);
    const outcome = await createFileLock(script.ops, 'darwin').claim('/run/x.lock');
    if (outcome.kind !== 'claimed') throw new Error('expected a claim');
    expect(outcome.lock.descriptor).toBe(100);
    outcome.lock.release();
    outcome.lock.release();
    expect(script.closed).toEqual([100]);
  });
});

describe('probing a file lock', () => {
  it('reports held when the shared lock is refused', async () => {
    expect(await createFileLock(scriptedOps(['shared-blocked']).ops, 'darwin').isHeld('/run/x.lock')).toBe(true);
  });

  it('reports free, and releases the shared lock it took, when the shared lock is granted', async () => {
    const script = scriptedOps(['shared-granted']);
    expect(await createFileLock(script.ops, 'darwin').isHeld('/run/x.lock')).toBe(false);
    expect(script.closed).toEqual([100]);
  });

  it('reports a missing lock file as free', async () => {
    expect(await createFileLock(scriptedOps(['shared-missing']).ops, 'darwin').isHeld('/run/x.lock')).toBe(false);
  });
});
