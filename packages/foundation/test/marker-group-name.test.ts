import { createTempDir, sleepDrivenTiming } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimRetry, markIgnored, readAttemptRecord, readMarkerGroup, reapMarkedProcesses, reconcileProcessGroup, recordMarkerGroup } from '../src/index.ts';
import type { MarkerState, ProcessGroupPort, ProcessInspector } from '../src/index.ts';
import { parseRecordedGroupName } from '../src/platform/marker-record.ts';
import type { GroupNames } from '../src/platform/group-port.ts';

const NAME = 'c4'.repeat(16);
const PGID = 4321;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const emptyMarker = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

const namesOf = (known: Record<number, string>): GroupNames & { recalled: Array<[number, string]> } => {
  const recalled: Array<[number, string]> = [];
  return { recalled, nameOf: (pgid) => known[pgid], recall: (pgid, name) => void recalled.push([pgid, name]) };
};

describe('the marker records the name of a group whose port names its groups', () => {
  it('writes the name on its own line after the group, and reads both back', async () => {
    const marker = emptyMarker();
    await recordMarkerGroup(marker, PGID, { names: namesOf({ [PGID]: NAME }) });
    expect(fs.readFileSync(marker, 'utf8')).toBe(`r00000\ng0000004321\nj${NAME}\n`);
    expect(await readMarkerGroup(marker)).toBe(PGID);
    expect(parseRecordedGroupName(fs.readFileSync(marker, 'utf8'))).toBe(NAME);
  });

  it('writes no name line for a port that names no groups, and for a group the port has no name for', async () => {
    const unnamed = emptyMarker();
    await recordMarkerGroup(unnamed, PGID, { names: namesOf({}) });
    expect(fs.readFileSync(unnamed, 'utf8')).toBe('r00000\ng0000004321\n');
    expect(parseRecordedGroupName(fs.readFileSync(unnamed, 'utf8'))).toBeUndefined();
    const posix = emptyMarker();
    await recordMarkerGroup(posix, PGID);
    expect(fs.readFileSync(posix, 'utf8')).toBe('r00000\ng0000004321\n');
  });

  it('keeps the name beside the attempt record when retries are claimed and the marker is ignored', async () => {
    const marker = emptyMarker();
    await claimRetry(marker, 'guard', { signal: new AbortController().signal });
    await recordMarkerGroup(marker, PGID, { names: namesOf({ [PGID]: NAME }) });
    await claimRetry(marker, 'sweep', { signal: new AbortController().signal });
    await markIgnored(marker, { signal: new AbortController().signal });
    expect(parseRecordedGroupName(fs.readFileSync(marker, 'utf8'))).toBe(NAME);
    expect(await readMarkerGroup(marker)).toBe(PGID);
    expect(await readAttemptRecord(marker)).toEqual({ spent: { guard: true, sweep: true, startup: false, shutdown: false }, ignored: true });
  });

  it('reads no name from anything that is not 128 bits of lower-case hex on the line after the group', () => {
    expect(parseRecordedGroupName(`r00000\ng0000004321\nj${NAME.toUpperCase()}\n`)).toBeUndefined();
    expect(parseRecordedGroupName(`r00000\ng0000004321\nj${NAME}0\n`)).toBeUndefined();
    expect(parseRecordedGroupName(`r00000\nj${NAME}\n`)).toBeUndefined();
  });
});

describe('a reconcile gives the recorded name to the port before it asks the port anything', () => {
  it('recalls the name of the recorded group, read from the marker, and only for a port that names its groups', async () => {
    const marker = emptyMarker();
    await recordMarkerGroup(marker, PGID, { names: namesOf({ [PGID]: NAME }) });
    const order: string[] = [];
    const names = namesOf({});
    const inspector: ProcessInspector = {
      startTimeOf: async () => ({ kind: 'gone' }),
      holdersOf: async () => ({ kind: 'value', value: [] }),
      groupsOf: async () => ({ kind: 'value', value: new Map() }),
      markerState: async (): Promise<MarkerState> => 'free',
    };
    const port: ProcessGroupPort = {
      names: { nameOf: names.nameOf, recall: (pgid, name) => void order.push(`recall ${pgid} ${name}`) },
      signal: async () => 'sent' as const,
      alive: async (pgid) => {
        order.push(`alive ${pgid}`);
        return false;
      },
    };
    let now = 0;
    const timing = sleepDrivenTiming({ now: () => now, sleep: async (ms: number) => void (now += ms) });
    await reconcileProcessGroup({ pgid: PGID, marker }, { killGraceMs: 10, groupPort: port, timing, inspector, signal: new AbortController().signal });
    expect(order).toEqual([`recall ${PGID} ${NAME}`, `alive ${PGID}`]);
    const unnamed: string[] = [];
    await reconcileProcessGroup(
      { pgid: PGID, marker },
      { killGraceMs: 10, groupPort: { signal: async () => 'sent' as const, alive: async () => (unnamed.push('alive'), false) }, timing, inspector, signal: new AbortController().signal },
    );
    expect(unnamed).toEqual(['alive']);
  });

  it('recalls nothing when the marker records another group than the one asked about', async () => {
    const marker = emptyMarker();
    await recordMarkerGroup(marker, PGID, { names: namesOf({ [PGID]: NAME }) });
    const names = namesOf({});
    const inspector: ProcessInspector = {
      startTimeOf: async () => ({ kind: 'gone' }),
      holdersOf: async () => ({ kind: 'value', value: [] }),
      groupsOf: async () => ({ kind: 'value', value: new Map() }),
      markerState: async (): Promise<MarkerState> => 'free',
    };
    let now = 0;
    await reconcileProcessGroup(
      { pgid: 9999, marker },
      { killGraceMs: 10, groupPort: { names, signal: async () => 'sent' as const, alive: async () => false }, timing: sleepDrivenTiming({ now: () => now, sleep: async (ms: number) => void (now += ms) }), inspector, signal: new AbortController().signal },
    );
    expect(names.recalled).toEqual([]);
  });

  it('a reap that reads the group from the marker recalls its name before any read of the group, and removes the marker of a job that is gone', async () => {
    const marker = emptyMarker();
    await recordMarkerGroup(marker, PGID, { names: namesOf({ [PGID]: NAME }) });
    const order: string[] = [];
    const inspector: ProcessInspector = {
      startTimeOf: async () => ({ kind: 'gone' }),
      holdersOf: async () => ({ kind: 'value', value: [] }),
      groupsOf: async (pids, candidates) => {
        order.push(`groups ${candidates.join(',')}`);
        return { kind: 'value', value: new Map(pids.map((pid) => [pid, pid])) };
      },
      markerState: async (): Promise<MarkerState> => 'free',
    };
    const groupPort: ProcessGroupPort = {
      names: { nameOf: () => undefined, recall: (pgid, name) => void order.push(`recall ${pgid} ${name}`) },
      signal: async () => 'sent' as const,
      alive: async () => false,
    };
    let now = 0;
    const reaped = await reapMarkedProcesses({ marker, killGraceMs: 10, label: 'test', onWarning: () => undefined, groupPort, timing: sleepDrivenTiming({ now: () => now, sleep: async (ms: number) => void (now += ms) }), inspector });
    expect(order.slice(0, 2)).toEqual([`recall ${PGID} ${NAME}`, `groups ${PGID}`]);
    expect(reaped).toEqual({ removed: true });
  });
});
