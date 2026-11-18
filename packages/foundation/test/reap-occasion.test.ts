import { createTempDir, sleepDrivenTiming } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeFailed, reapMarkerDirectory } from '@momonga/foundation';
import type { ProcessInspector, SignalSender } from '@momonga/foundation';

const SURVIVOR_PID = 4242;
const KILL_GRACE_MS = 100;
const MARKER_NAME = '6f1c2a9e-0b7d-4a51-9c3e-2d8f5b7a1e04';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const markerDirectoryWith = (record: string): { dir: string; marker: string } => {
  const root = createTempDir();
  dirs.push(root);
  const dir = path.join(root, 'targets', 'apple');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, MARKER_NAME);
  fs.writeFileSync(marker, record, { mode: 0o600 });
  return { dir, marker };
};

const survivingWorld = () => {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const warnings: string[] = [];
  let now = 0;
  const inspector = {
    startTimeOf: async () => ({ kind: 'value', value: 1n }),
    holdersOf: async () => ({ kind: 'value', value: [SURVIVOR_PID] }),
    groupsOf: async () => ({ kind: 'value', value: new Map([[SURVIVOR_PID, SURVIVOR_PID]]) }),
    markerState: async () => 'held',
  } as unknown as ProcessInspector;
  const kill: SignalSender = (pid, signal) => {
    if (signal !== 0) sent.push([pid, signal]);
  };
  const timing = sleepDrivenTiming({ now: () => now, sleep: async (ms: number) => void (now += ms) });
  return { sent, warnings, inspector, kill, timing };
};

type ReapOptions = Parameters<typeof reapMarkerDirectory>[0];

const reapAt = (dir: string, occasion: string, world: ReturnType<typeof survivingWorld>, label = 'managed server') =>
  reapMarkerDirectory({
    dir,
    occasion,
    killGraceMs: KILL_GRACE_MS,
    label,
    onWarning: (message: string) => world.warnings.push(message),
    kill: world.kill,
    timing: world.timing,
    inspector: world.inspector,
    signal: new AbortController().signal,
  } as ReapOptions);

describe('a managed server marker follows decision 12 (design-managed-servers section 17, item 17)', () => {
  it('spends the start-up retry of a survivor once: the first start signals it and records the attempt, the next start does not signal it again', async () => {
    const world = survivingWorld();
    const { dir, marker } = markerDirectoryWith('r00000\n');
    await reapAt(dir, 'startup', world);
    expect(world.sent.length).toBeGreaterThan(0);
    expect(fs.readFileSync(marker, 'utf8').slice(0, 7)).toBe('r00100\n');
    world.sent.length = 0;
    await reapAt(dir, 'startup', world);
    expect(world.sent).toEqual([]);
  });

  it('after the four retries, signals nothing and tells the person the marker name and /markers ignore', async () => {
    const world = survivingWorld();
    const { dir } = markerDirectoryWith('r11110\n');
    await reapAt(dir, 'startup', world);
    expect(world.sent).toEqual([]);
    expect(world.warnings.some((warning) => warning.includes(`marker ${MARKER_NAME}`) && warning.includes(`/markers ignore ${MARKER_NAME}`))).toBe(true);
  });

  it('never signals a marker the person ignored, and says nothing about it', async () => {
    const world = survivingWorld();
    const { dir } = markerDirectoryWith('r00001\n');
    await reapAt(dir, 'startup', world);
    expect(world.sent).toEqual([]);
    expect(world.warnings).toEqual([]);
  });
});

describe('the final notice of a survivor is said only after the fourth chance, with the label of the asker (design 19.6 point 12, decision R06-12)', () => {
  it.each(['tool', 'mcp', 'job', 'daemon'])('says the %s notice exactly once all four chances are spent', async (label) => {
    const world = survivingWorld();
    const { dir } = markerDirectoryWith('r01110\n');
    await reapAt(dir, 'guard', world, label);
    expect(world.warnings).toContain(
      `a ${label} process (marker ${MARKER_NAME}) may still be running. MomongaCode has used its 4 retries and will not try again. Stop the process that holds it, or, if it can stay running, run /markers ignore ${MARKER_NAME} in an interactive session.`,
    );
  });

  it.each(['tool', 'mcp', 'job', 'daemon'])('says neither the retries nor /markers ignore for %s at a chance that leaves others', async (label) => {
    const world = survivingWorld();
    const { dir } = markerDirectoryWith('r00000\n');
    await reapAt(dir, 'startup', world, label);
    expect(world.warnings.filter((warning) => warning.includes('retries') || warning.includes('/markers ignore'))).toEqual([]);
  });
});

describe('a marker record is told apart from a spent one, and a reap that ends with its marker kept always says why', () => {
  it('a malformed attempt record is reported as malformed, never as retries spent, and nothing is signalled', async () => {
    const world = survivingWorld();
    const { dir } = markerDirectoryWith('42\n');
    await reapAt(dir, 'startup', world, 'daemon');
    expect(world.sent).toEqual([]);
    expect(world.warnings).toEqual([`a daemon process (marker ${MARKER_NAME}) may still be running. The attempt record of its marker is malformed, so MomongaCode does not try to stop it. Stop the process that holds it, or, if it can stay running, run /markers ignore ${MARKER_NAME} in an interactive session.`]);
  });

  it('a reap whose processes are gone but whose marker cannot be read as free says so', async () => {
    const world = survivingWorld();
    const inspector = { ...world.inspector, holdersOf: async () => ({ kind: 'value', value: [] }), markerState: async () => 'unknown' } as unknown as ProcessInspector;
    const { dir } = markerDirectoryWith('r00000\n');
    await reapMarkerDirectory({ dir, occasion: 'sweep', killGraceMs: KILL_GRACE_MS, label: 'daemon', onWarning: (message: string) => world.warnings.push(message), kill: world.kill, timing: world.timing, inspector, signal: new AbortController().signal } as ReapOptions);
    expect(world.warnings).toEqual([`daemon marker ${path.join(dir, MARKER_NAME)} kept: no process holds it, but its state reads unknown rather than free`]);
  });
});

describe('a pass that could not read the state it needs does not spend a chance; only a stop that left the process alive does', () => {
  const unparseable = () => probeFailed({ kind: 'unparseable', detail: 'the reader printed nothing' });
  const unreadWorlds: ReadonlyArray<[string, Partial<Record<keyof ProcessInspector, unknown>>]> = [
    ['the listing', { holdersOf: async () => unparseable() }],
    ['the group read', { groupsOf: async () => unparseable() }],
    ['the marker-state read', { holdersOf: async () => ({ kind: 'value', value: [] }), markerState: async () => 'unknown' }],
  ];

  it.each(unreadWorlds)('a pass whose %s cannot be made leaves the sweep chance unspent, says no retries are used up, and the next pass stops the process', async (_read, failing) => {
    const world = survivingWorld();
    const { dir, marker } = markerDirectoryWith('r00000\n');
    const unread = { ...world, inspector: { ...world.inspector, ...failing } as unknown as ProcessInspector };
    await reapAt(dir, 'sweep', unread, 'daemon');
    expect(fs.readFileSync(marker, 'utf8').slice(0, 7)).toBe('r00000\n');
    expect(unread.warnings.filter((warning) => warning.includes('will not try again'))).toEqual([]);
    world.sent.length = 0;
    await reapAt(dir, 'sweep', world, 'daemon');
    expect(world.sent.length).toBeGreaterThan(0);
    expect(fs.readFileSync(marker, 'utf8').slice(0, 7)).toBe('r01000\n');
  });

  it('a pass whose last chance meets an unreadable listing keeps the chance and does not tell the person the retries are used up', async () => {
    const world = survivingWorld();
    const { dir, marker } = markerDirectoryWith('r10110\n');
    const unread = { ...world, inspector: { ...world.inspector, holdersOf: async () => unparseable() } as unknown as ProcessInspector };
    await reapAt(dir, 'sweep', unread, 'daemon');
    expect(fs.readFileSync(marker, 'utf8').slice(0, 7)).toBe('r10110\n');
    expect(unread.warnings.filter((warning) => warning.includes('will not try again'))).toEqual([]);
  });
});
