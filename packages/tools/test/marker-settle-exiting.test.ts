import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarkerReconcileResult } from '@momonga/foundation';
import { settleFinishedCommand } from '../src/marker-settle.ts';
import type { MarkerSettle } from '../src/marker-settle.ts';

const PGID = 1_999_999_021;

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`kill ${code}`), { code });

afterEach(() => {
  vi.restoreAllMocks();
});

const heldByNobodyNamed = (): MarkerSettle => ({
  mode: 'listed',
  cached: () => 'held',
  state: async () => 'held',
  list: async () => ({ holders: [], refused: [] }),
  reap: async (): Promise<MarkerReconcileResult> => {
    throw new Error('nothing was named, so nothing is reaped');
  },
  remove: async () => undefined,
  discard: async () => undefined,
});

describe('a finished command whose marker is still held only by members that are exiting', () => {
  it('does not tell the user that a process started by it is still running', async () => {
    vi.spyOn(process, 'kill').mockImplementation((target: number) => {
      throw errno(target === -PGID ? 'EPERM' : 'ESRCH');
    });
    const notes = await settleFinishedCommand(heldByNobodyNamed(), { pgid: PGID, exit: { code: 0, signal: null }, signal: new AbortController().signal });
    expect(notes.filter((note) => note.includes('still running'))).toEqual([]);
  });
});
