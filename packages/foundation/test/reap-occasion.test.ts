import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reapMarkerDirectory } from '@momonga/foundation';
import type { ProcessInspector, SignalSender } from '@momonga/foundation';

const SURVIVOR_PID = 4242;
const KILL_GRACE_MS = 100;
const MARKER_NAME = '6f1c2a9e-0b7d-4a51-9c3e-2d8f5b7a1e04';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const markerDirectoryWith = (record: string): { dir: string; marker: string } => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-occasion-')));
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
  const timing = { now: () => now, sleep: async (ms: number) => void (now += ms) };
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
      `a ${label} process (marker ${MARKER_NAME}) may still be running. MomongaCode has used its 4 retries and will not try again. If it can stay running, run /markers ignore ${MARKER_NAME}.`,
    );
  });

  it.each(['tool', 'mcp', 'job', 'daemon'])('says neither the retries nor /markers ignore for %s at a chance that leaves others', async (label) => {
    const world = survivingWorld();
    const { dir } = markerDirectoryWith('r00000\n');
    await reapAt(dir, 'startup', world, label);
    expect(world.warnings.filter((warning) => warning.includes('retries') || warning.includes('/markers ignore'))).toEqual([]);
  });
});
