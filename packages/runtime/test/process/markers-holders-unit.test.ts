import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReapMarkedProcessesOptions } from '@momonga/foundation';
import type { IdempotencyLookup } from '@momonga/store';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { makeTempHome } from './helpers.ts';

const holderState = vi.hoisted(() => ({ byMarker: new Map<string, number[] | Error>() }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...actual,
    findHolders: async (marker: string): Promise<number[]> => {
      const entry = holderState.byMarker.get(marker);
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    },
  };
});

const keyOf = (n: number): string => n.toString(16).padStart(64, '0');

const setup = async () => {
  holderState.byMarker.clear();
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
