import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as foundation from '../src/index.ts';
import { claimRetry, markIgnored, readAttemptRecord } from '../src/index.ts';

type MarkerGroupApi = {
  recordMarkerGroup(marker: string, pgid: number): Promise<void>;
  readMarkerGroup(marker: string): Promise<number | undefined>;
};

const markerGroups = foundation as unknown as MarkerGroupApi;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const emptyMarker = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-marker-group-'));
  dirs.push(dir);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

describe('the marker file records the process group of its spawn next to its attempt record', () => {
  it('reads no group from a marker that never recorded one', async () => {
    expect(await markerGroups.readMarkerGroup(emptyMarker())).toBeUndefined();
  });

  it('reads back the recorded group', async () => {
    const marker = emptyMarker();
    await markerGroups.recordMarkerGroup(marker, 4321);
    expect(await markerGroups.readMarkerGroup(marker)).toBe(4321);
  });

  it('keeps the group and the attempt record apart when retries are claimed and the marker is ignored', async () => {
    const marker = emptyMarker();
    await markerGroups.recordMarkerGroup(marker, 4321);
    const signal = new AbortController().signal;
    expect(await claimRetry(marker, 'guard', { signal })).toBe('claimed');
    expect(await claimRetry(marker, 'startup', { signal })).toBe('claimed');
    await markIgnored(marker, { signal });
    expect(await readAttemptRecord(marker)).toEqual({ spent: { guard: true, sweep: false, startup: true, shutdown: false }, ignored: true });
    expect(await markerGroups.readMarkerGroup(marker)).toBe(4321);
  });

  it('keeps the attempt record when the group is recorded after a retry was claimed', async () => {
    const marker = emptyMarker();
    const signal = new AbortController().signal;
    expect(await claimRetry(marker, 'sweep', { signal })).toBe('claimed');
    await markerGroups.recordMarkerGroup(marker, 4321);
    expect(await readAttemptRecord(marker)).toEqual({ spent: { guard: false, sweep: true, startup: false, shutdown: false }, ignored: false });
    expect(await markerGroups.readMarkerGroup(marker)).toBe(4321);
  });
});
