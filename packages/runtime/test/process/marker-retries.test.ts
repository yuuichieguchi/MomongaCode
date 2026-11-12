import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessInspector } from '@momonga/foundation';
import { createMarkerOwners, unsettledKeys } from '@momonga/tools';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { createTempDir } from '@momonga/testkit';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const markerDir = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  return dir;
};

const heldInspector = { markerState: async () => 'held', holdersOf: async () => ({ kind: 'value', value: [] }), startTimeOf: async () => ({ kind: 'gone' }), groupsOf: async () => ({ kind: 'value', value: new Map() }) } as unknown as ProcessInspector;

const store = { idempotency: { get: () => undefined, processGroupOf: () => undefined }, getRun: () => undefined } as never;

const NAME = 'e'.repeat(64);

describe('T17 (a) the sweep, start-up and shutdown each retry a held marker once (decision 12)', () => {
  it.for([
    ['startup', 'r00100\n'],
    ['sweep', 'r01000\n'],
    ['shutdown', 'r00010\n'],
  ] as const)('the %s event reaps once in the life of the marker and records its byte first', async ([event, record]) => {
    const dir = markerDir();
    const marker = path.join(dir, NAME);
    fs.writeFileSync(marker, 'r00000\n');
    const reaped: Array<{ marker: string; record: string }> = [];
    const reap = async (options: { marker: string }) => {
      reaped.push({ marker: options.marker, record: fs.readFileSync(options.marker, 'utf8') });
      return { removed: false };
    };
    const owners = createMarkerOwners();
    for (let tick = 0; tick < 2; tick += 1) {
      await reapToolMarkers({ dir, store, killGraceMs: 100, onWarning: () => undefined, inspector: heldInspector, reap: reap as never, event, owners, signal: new AbortController().signal } as never);
    }
    expect(reaped).toEqual([{ marker, record }]);
    expect(fs.readFileSync(marker, 'utf8')).toBe(record);
  });

  it('a marker whose four retries are spent is still read and removed once it is free', async () => {
    const dir = markerDir();
    const marker = path.join(dir, NAME);
    fs.writeFileSync(marker, 'r11110\n');
    const reaped: string[] = [];
    const freeInspector = { ...heldInspector, markerState: async () => 'free' } as unknown as ProcessInspector;
    await reapToolMarkers({ dir, store, killGraceMs: 100, onWarning: () => undefined, inspector: freeInspector, reap: (async (options: { marker: string }) => { reaped.push(options.marker); return { removed: true }; }) as never, event: 'sweep', owners: createMarkerOwners(), signal: new AbortController().signal } as never);
    expect(reaped).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('T15 / T16 the unsettled set is every marker file no live owner owns', () => {
  it('a marker of a lost call is unsettled; a marker whose owner lives is not; a released owner leaves it unsettled', async () => {
    const dir = markerDir();
    fs.writeFileSync(path.join(dir, 'lost'), 'r00000\n');
    fs.writeFileSync(path.join(dir, 'job'), 'r00000\n');
    const owners = createMarkerOwners();
    let alive = true;
    owners.register('job', { alive: () => alive });
    expect((await unsettledKeys(dir, owners)).sort()).toEqual(['lost']);
    alive = false;
    expect((await unsettledKeys(dir, owners)).sort()).toEqual(['job', 'lost']);
  });

  it('a promoted call transfers its marker to the job without renaming it', async () => {
    const dir = markerDir();
    fs.writeFileSync(path.join(dir, 'call-key'), 'r00000\n');
    const owners = createMarkerOwners();
    owners.register('call-key', { alive: () => false });
    owners.transfer('call-key', { alive: () => true });
    expect(await unsettledKeys(dir, owners)).toEqual([]);
  });

  it('(T16 e) the guard and the sweeps take their keys only from unsettledKeys: no skipKeys or liveKeys filter remains', () => {
    for (const relative of ['packages/runtime/src/process/start-runtime-process.ts', 'packages/runtime/src/process/tool-runtime.ts', 'packages/runtime/src/process/tool-markers.ts']) {
      expect({ relative, filters: /skipKeys|liveKeys\(\)/.test(fs.readFileSync(path.join(ROOT, relative), 'utf8')) }).toEqual({ relative, filters: false });
    }
  });
});

const stateInspector = (states: Record<string, string>) =>
  ({ ...heldInspector, markerState: async (marker: string) => states[path.basename(marker)] ?? 'held' }) as unknown as ProcessInspector;

describe('T17 (c) the record is written before the reap (write-ahead)', () => {
  it('a reap that fails after the claim leaves the retry spent, and the next event of that kind does not reap', async () => {
    const dir = markerDir();
    const marker = path.join(dir, NAME);
    fs.writeFileSync(marker, 'r00000\n');
    let reaps = 0;
    const crashing = async () => {
      reaps += 1;
      throw new Error('the runtime died here: injected');
    };
    for (let tick = 0; tick < 2; tick += 1) {
      await reapToolMarkers({ dir, store, killGraceMs: 100, onWarning: () => undefined, inspector: heldInspector, reap: crashing as never, event: 'startup', owners: createMarkerOwners(), signal: new AbortController().signal } as never).catch(() => undefined);
    }
    expect(reaps).toBe(1);
    expect(fs.readFileSync(marker, 'utf8')).toBe('r00100\n');
  });
});

describe('T16 (d) after a crash with a live job no owner is alive', () => {
  it('the start-up sweep reaps the job marker and removes a marker whose state is free', async () => {
    const dir = markerDir();
    fs.writeFileSync(path.join(dir, 'job-key'), 'r00000\n');
    fs.writeFileSync(path.join(dir, 'free-key'), 'r00000\n');
    const reaped: string[] = [];
    await reapToolMarkers({
      dir,
      store,
      killGraceMs: 100,
      onWarning: () => undefined,
      inspector: stateInspector({ 'job-key': 'held', 'free-key': 'free' }),
      reap: (async (options: { marker: string }) => {
        reaped.push(path.basename(options.marker));
        return { removed: false };
      }) as never,
      event: 'startup',
      owners: createMarkerOwners(),
      signal: new AbortController().signal,
    } as never);
    expect(reaped).toEqual(['job-key']);
    expect(fs.existsSync(path.join(dir, 'free-key'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'job-key'))).toBe(true);
  });

  it('a marker owned by a live owner is neither read nor reaped by any sweep', async () => {
    const dir = markerDir();
    fs.writeFileSync(path.join(dir, 'owned'), 'r00000\n');
    const owners = createMarkerOwners();
    owners.register('owned', { alive: () => true });
    const reaped: string[] = [];
    for (const event of ['startup', 'sweep', 'shutdown']) {
      await reapToolMarkers({ dir, store, killGraceMs: 100, onWarning: () => undefined, inspector: heldInspector, reap: (async (options: { marker: string }) => { reaped.push(options.marker); return { removed: false }; }) as never, event, owners, signal: new AbortController().signal } as never);
    }
    expect(reaped).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'owned'), 'utf8')).toBe('r00000\n');
  });
});

