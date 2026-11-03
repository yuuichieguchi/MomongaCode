import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReapMarkedProcessesOptions } from '@momonga/foundation';
import type { IdempotencyLookup } from '@momonga/store';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { makeTempHome } from './helpers.ts';

const holderState = vi.hoisted(() => ({
  byMarker: new Map<string, number[] | Error>(),
  unreadable: [] as Array<{ pid: number; command: string; startTicks: string }>,
}));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...actual,
    findHolders: async (marker: string, _inspector?: unknown, onUninspectable?: (process: { pid: number; command: string; startTicks: string }) => void): Promise<number[]> => {
      for (const process of holderState.unreadable) onUninspectable?.(process);
      const entry = holderState.byMarker.get(marker);
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    },
  };
});

const keyOf = (n: number): string => n.toString(16).padStart(64, '0');

const setup = async () => {
  holderState.byMarker.clear();
  holderState.unreadable = [];
  const temp = await makeTempHome();
  const marker = (n: number): string => {
    const file = path.join(temp.paths.markers.tools, keyOf(n));
    fs.writeFileSync(file, '', { mode: 0o600 });
    return file;
  };
  const calls: ReapMarkedProcessesOptions[] = [];
  const reap = async (options: ReapMarkedProcessesOptions) => {
    calls.push(options);
    return { removed: true };
  };
  const messages: string[] = [];
  return { temp, marker, calls, reap, messages, onWarning: (message: string) => void messages.push(message) };
};

describe('reapToolMarkers with a failing holder check (system timers, none used; findHolders mocked per marker, no real processes)', () => {
  it('a findHolders rejection for one marker is a warning and the other markers are still reaped', async () => {
    const s = await setup();
    const broken = s.marker(1);
    const held = s.marker(2);
    holderState.byMarker.set(broken, new Error('lsof failed'));
    holderState.byMarker.set(held, [999_999]);
    const store = { idempotency: { get: (): IdempotencyLookup | undefined => undefined } } as never;

    await reapToolMarkers({ dir: s.temp.paths.markers.tools, store, killGraceMs: 2000, onWarning: s.onWarning, reap: s.reap as never });

    expect(s.calls.map((call) => call.marker)).toEqual([held]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toContain(broken);
  });

  it('names a process that cannot be inspected through the warning path, once for the life of the process across sweeps', async () => {
    const s = await setup();
    const held = s.marker(3);
    holderState.byMarker.set(held, [999_999]);
    holderState.unreadable = [{ pid: 31_337, command: 'ssh-agent', startTicks: '424242' }];
    const store = { idempotency: { get: (): IdempotencyLookup | undefined => undefined } } as never;

    for (let sweep = 0; sweep < 3; sweep += 1) {
      await reapToolMarkers({ dir: s.temp.paths.markers.tools, store, killGraceMs: 2000, onWarning: s.onWarning, reap: s.reap as never });
    }

    expect(s.messages).toEqual([`tool marker ${held}: process 31337 (ssh-agent) could not be inspected, so it was left alone`]);
  });

  it('a store error still propagates before any reap when another marker has a failing holder check', async () => {
    const s = await setup();
    const broken = s.marker(1);
    const held = s.marker(2);
    holderState.byMarker.set(broken, new Error('lsof failed'));
    holderState.byMarker.set(held, [999_999]);
    const failure = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
    const store = {
      idempotency: {
        get: (): IdempotencyLookup | undefined => {
          throw failure;
        },
      },
    } as never;

    await expect(reapToolMarkers({ dir: s.temp.paths.markers.tools, store, killGraceMs: 2000, onWarning: s.onWarning, reap: s.reap as never })).rejects.toBe(failure);
    expect(s.calls).toEqual([]);
  });
});
