import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcessInspector, ReapMarkedProcessesOptions } from '@momonga/foundation';
import type { IdempotencyLookup } from '@momonga/store';
import { createMarkerOwners } from '@momonga/tools';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { makeTempHome } from './helpers.ts';

const keyOf = (n: number): string => n.toString(16).padStart(64, '0');

const inspectorOf = (byMarker: Map<string, 'held' | Error>): ProcessInspector =>
  ({
    markerState: async (marker: string) => {
      const entry = byMarker.get(marker);
      if (entry instanceof Error) throw entry;
      return entry ?? 'free';
    },
  }) as unknown as ProcessInspector;

const setup = async () => {
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

describe('reapToolMarkers with a failing state check (the inspector is a fake; no real processes)', () => {
  it('a state check that rejects for one marker is a warning and the other markers are still reaped', async () => {
    const s = await setup();
    const broken = s.marker(1);
    const held = s.marker(2);
    const store = { idempotency: { get: (): IdempotencyLookup | undefined => undefined } } as never;
    const inspector = inspectorOf(new Map<string, 'held' | Error>([[broken, new Error('lsof failed')], [held, 'held']]));

    await reapToolMarkers({ event: 'startup', owners: createMarkerOwners(), inspector, dir: s.temp.paths.markers.tools, store, killGraceMs: 2000, onWarning: s.onWarning, reap: s.reap as never });

    expect(s.calls.map((call) => call.marker)).toEqual([held]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toContain(broken);
  });

  it('a store error still propagates before any reap when another marker has a failing state check', async () => {
    const s = await setup();
    const broken = s.marker(1);
    const held = s.marker(2);
    const failure = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
    const store = {
      idempotency: {
        get: (): IdempotencyLookup | undefined => {
          throw failure;
        },
      },
    } as never;
    const inspector = inspectorOf(new Map<string, 'held' | Error>([[broken, new Error('lsof failed')], [held, 'held']]));

    await expect(reapToolMarkers({ event: 'startup', owners: createMarkerOwners(), inspector, dir: s.temp.paths.markers.tools, store, killGraceMs: 2000, onWarning: s.onWarning, reap: s.reap as never })).rejects.toBe(failure);
    expect(s.calls).toEqual([]);
  });
});
