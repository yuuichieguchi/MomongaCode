import { describe, expect, it } from 'vitest';
import { atomicWriteSequence } from '../src/atomic-file.ts';
import type { AtomicWriteOperation } from '../src/atomic-file.ts';
import type { HeldKernelLock, KernelLockMechanism } from '../src/platform/kernel-lock.ts';
import { createFakeRandom } from '@momonga/testkit';

const FILE = '/state/record.json';

const mechanismOf = (name: KernelLockMechanism['name']): KernelLockMechanism => ({ name }) as KernelLockMechanism;

type Drive = { asked: string[]; lockEvents: string[]; result: unknown; thrown: unknown };

const drive = (name: KernelLockMechanism['name'], publish: 'replace' | 'create', failAt?: { run: AtomicWriteOperation['run']; error: Error }): Drive => {
  const asked: string[] = [];
  const lockEvents: string[] = [];
  const held: HeldKernelLock = { descriptor: undefined, writeHolder: () => undefined, release: () => void lockEvents.push('release'), dispose: () => void lockEvents.push('dispose') };
  const open = { write: () => undefined, sync: () => undefined, close: () => undefined };
  const answerOf = (operation: AtomicWriteOperation): unknown => {
    if (operation.run === 'claim') return held;
    if (operation.run === 'openClaimed' || operation.run === 'create') return open;
    return undefined;
  };
  const work = atomicWriteSequence(mechanismOf(name), createFakeRandom(7), FILE, 'content', { mode: 0o600, publish, lock: mechanismOf(name) });
  let failed = false;
  try {
    let turn = work.next();
    while (turn.done !== true) {
      asked.push(turn.value.run);
      if (!failed && failAt !== undefined && turn.value.run === failAt.run) {
        failed = true;
        turn = work.throw(failAt.error);
      } else turn = work.next(answerOf(turn.value));
    }
    return { asked, lockEvents, result: turn.value, thrown: undefined };
  } catch (error) {
    return { asked, lockEvents, result: undefined, thrown: error };
  }
};

describe('the one atomic write sequence, asked of whichever driver runs it', () => {
  it('asks for the operations of a replace under an entry lock in the one order', () => {
    const { asked, lockEvents, result } = drive('file-lock', 'replace');
    expect(asked).toEqual(['claim', 'openClaimed', 'write', 'sync', 'close', 'beforePublish', 'rename', 'afterPublish', 'syncDirectory']);
    expect(lockEvents).toEqual(['release']);
    expect(result).toBeUndefined();
  });

  it('asks for the operations of a create under a sidecar lock in the one order and says that it created the file', () => {
    const { asked, lockEvents, result } = drive('sqlite-lock', 'create');
    expect(asked).toEqual(['claim', 'create', 'write', 'sync', 'close', 'beforePublish', 'link', 'afterPublish', 'remove', 'syncDirectory']);
    expect(lockEvents).toEqual(['dispose']);
    expect(result).toEqual({ created: true });
  });

  it('a create whose link finds the file says so, skips afterPublish and still removes its temporary', () => {
    const exists = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const { asked, result, thrown } = drive('file-lock', 'create', { run: 'link', error: exists });
    expect(thrown).toBeUndefined();
    expect(asked).toEqual(['claim', 'openClaimed', 'write', 'sync', 'close', 'beforePublish', 'link', 'remove', 'syncDirectory']);
    expect(result).toEqual({ created: false });
  });

  it.for(['write', 'sync', 'beforePublish', 'rename'] as const)('a failure of %s closes what is open, removes the temporary, frees the lock and is the error of the write', (run) => {
    const failure = new Error(`${run} failed`);
    const { asked, lockEvents, thrown } = drive('file-lock', 'replace', { run, error: failure });
    expect(thrown).toBe(failure);
    expect(asked.at(-1)).toBe('remove');
    expect(asked.filter((operation) => operation === 'close')).toHaveLength(1);
    expect(asked).not.toContain('syncDirectory');
    expect(lockEvents).toEqual(['release']);
  });
});
