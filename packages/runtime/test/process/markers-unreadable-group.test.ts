import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcessInspector, ReapMarkedProcessesOptions } from '@momonga/foundation';
import type { IdempotencyLookup } from '@momonga/store';
import { createMarkerOwners } from '@momonga/tools';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { makeTempHome } from './helpers.ts';

const keyOf = (n: number): string => n.toString(16).padStart(64, '0');

const heldInspector = { markerState: async () => 'held' } as unknown as ProcessInspector;

describe('reapToolMarkers when the group of one marker cannot be read (the inspector is a fake; no real processes)', () => {
  it('reports the unreadable marker once with its name and reason, leaves it in place, and still plans and reaps every other marker with its recorded group', async () => {
    const temp = await makeTempHome();
    const dir = temp.paths.markers.tools;
    const unreadable = path.join(dir, keyOf(1));
    fs.mkdirSync(unreadable);
    const first = path.join(dir, keyOf(2));
    fs.writeFileSync(first, 'r00000\ng0000004321\n', { mode: 0o600 });
    const second = path.join(dir, keyOf(3));
    fs.writeFileSync(second, 'r00000\ng0000005678\n', { mode: 0o600 });
    const calls: ReapMarkedProcessesOptions[] = [];
    const reap = async (options: ReapMarkedProcessesOptions) => {
      calls.push(options);
      return { removed: true };
    };
    const messages: string[] = [];
    const store = { idempotency: { get: (): IdempotencyLookup | undefined => undefined, processGroupOf: (): number | undefined => undefined }, getRun: () => undefined } as never;

    await reapToolMarkers({ event: 'startup', owners: createMarkerOwners(), inspector: heldInspector, dir, store, killGraceMs: 2000, onWarning: (message) => void messages.push(message), reap: reap as never });

    expect(calls.map((call) => [call.marker, call.pgid]).sort()).toEqual([
      [first, 4321],
      [second, 5678],
    ]);
    const aboutUnreadable = messages.filter((message) => message.includes(unreadable));
    expect(aboutUnreadable).toHaveLength(1);
    expect(aboutUnreadable[0]).toContain('EISDIR');
    expect(messages).toHaveLength(1);
    expect(fs.statSync(unreadable).isDirectory()).toBe(true);
  });
});
