import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPosixGroupPort, reapMarkedProcesses, reconcileProcessGroup } from '@momonga/foundation';
import type { ProcessGroupPort, ProcessInspector, ReapTiming } from '@momonga/foundation';
import { readManifest } from './formal/manifest.ts';

const specDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'ProcessStop.tla'), 'utf8');
const manifest = readManifest(path.join(specDir, 'manifest.json'));

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in ProcessStop.tla`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const variants = (): string[] => {
  const match = /ASSUME Variant \\in \{([^}]*)\}/.exec(spec);
  if (match === null) throw new Error('the Variant set is not declared in ProcessStop.tla');
  return (match[1] ?? '').split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
};

type Entry = { pgid: number; holdsMarker: boolean; startMs: number; startUnreadable?: boolean };

type World = { signals: Array<{ target: number; signal: NodeJS.Signals }>; kill: (target: number, signal: NodeJS.Signals | 0) => void; inspector: ProcessInspector; groupPort: ProcessGroupPort };

const world = (initial: Record<number, Entry>, reuseAtGroupRead: Record<number, Record<number, Entry>>): World => {
  const table = new Map<number, Entry>(Object.entries(initial).map(([pid, entry]) => [Number(pid), entry]));
  const signals: World['signals'] = [];
  let groupReads = 0;
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    const hit = target < 0 ? [...table].filter(([, entry]) => entry.pgid === -target).map(([pid]) => pid) : table.has(target) ? [target] : [];
    if (signal !== 0) signals.push({ target, signal });
    if (hit.length === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  };
  const inspector = {
    startTimeOf: async (pid: number) => {
      const entry = table.get(pid);
      if (entry === undefined) return { kind: 'gone' };
      if (entry.startUnreadable === true) return { kind: 'failed', cause: 'deterministic', evidence: { kind: 'exit', exitCode: 1, detail: 'ps exited with 1' } };
      return { kind: 'value', value: entry.startMs };
    },
    holdersOf: async () => ({ kind: 'value', value: [...table].filter(([, entry]) => entry.holdsMarker).map(([pid]) => pid) }),
    groupsOf: async (pids: readonly number[]) => {
      groupReads += 1;
      const rows = new Map(pids.filter((pid) => table.has(pid)).map((pid) => [pid, table.get(pid)!.pgid]));
      for (const [pid, entry] of Object.entries(reuseAtGroupRead[groupReads] ?? {})) table.set(Number(pid), entry);
      return { kind: 'value', value: rows };
    },
    markerState: async () => 'free',
  } as unknown as ProcessInspector;
  const groupPort = createPosixGroupPort({
    kill,
    reading: { states: async (pgid) => [...table.values()].filter((entry) => entry.pgid === pgid).map(() => 'S'), successMeansRunnable: false },
  });
  return { signals, kill, inspector, groupPort };
};

const instantTiming = (): ReapTiming => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  } as ReapTiming;
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const markerFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-stop-'));
  dirs.push(dir);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

const reconcile = async (scene: World) => reconcileProcessGroup({ pgid: 100, marker: markerFile() }, { killGraceMs: 1000, kill: scene.kill, groupPort: scene.groupPort, timing: instantTiming(), inspector: scene.inspector });

const stranger = (pgid: number): Entry => ({ pgid, holdsMarker: false, startMs: 999_999 });

describe('the reap signals only a target proved ours by the same start time at the listing and just before the signal, as specs/tla/ProcessStop.tla states', () => {
  it('the model proves a holder target only while its pid is not reused, and proves the group only by a listed holder in it that is not gone', () => {
    expect(definitionOf('HolderTargetProved')).toContain('~swapped[m]');
    expect(definitionOf('ListedHolderInGroup')).toContain('state[m] # "gone"');
    expect(definitionOf('ListedHolderInGroup')).not.toContain('swapped');
  });

  it.each(['signalUnprovedHolder', 'killWithoutReproof', 'groupProofWithoutStartTime'])('the code without the check, variant %s, is an every-run evidence configuration that violates NoSignalToUnprovedGroup', (variant) => {
    expect(variants()).toContain(variant);
    expect(manifest.entries.find((entry) => entry.config === `ProcessStop.${variant}`)).toMatchObject({ role: 'evidence', tier: 'every-run', expect: { violates: 'NoSignalToUnprovedGroup' } });
  });

  it('the model header states the one-second resolution of the darwin start time, which the darwin inspector still reads with ps -o lstart', () => {
    const darwin = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'packages', 'foundation', 'src', 'platform', 'darwin-inspector.ts'), 'utf8');
    expect(darwin).toContain("'lstart='");
    expect(spec).toContain('darwin reads a start time with ps -o lstart, whose resolution is one second');
  });

  it('the model header states that the window between holdersOf and the first startTimeOf cannot be closed where the listing carries no start time', () => {
    expect(spec).toContain('the window between holdersOf and the first startTimeOf cannot be closed where the listing carries no start time');
  });

  it('signalUnprovedHolder: a holder whose pid is reused before the SIGTERM is not signalled', async () => {
    const scene = world({ 100: { pgid: 100, holdsMarker: true, startMs: 1 }, 200: { pgid: 200, holdsMarker: true, startMs: 2 } }, { 1: { 200: stranger(300) } });
    await reconcile(scene);
    expect(scene.signals.filter(({ target }) => target === 200)).toEqual([]);
  });

  it('killWithoutReproof: a holder whose pid is reused after the SIGTERM pass is not sent SIGKILL', async () => {
    const scene = world({ 100: { pgid: 100, holdsMarker: true, startMs: 1 }, 200: { pgid: 200, holdsMarker: true, startMs: 2 } }, { 2: { 200: stranger(300) } });
    await reconcile(scene);
    expect(scene.signals.filter(({ target }) => target === 200)).toEqual([{ target: 200, signal: 'SIGTERM' }]);
  });

  it('groupProofWithoutStartTime: a group whose only listed holder is replaced by a process of a reused group is not signalled', async () => {
    const scene = world({ 100: { pgid: 100, holdsMarker: true, startMs: 1 } }, { 1: { 100: stranger(100) } });
    await reconcile(scene);
    expect(scene.signals).toEqual([]);
  });

  it('a target whose start time cannot be read is never proved, on either reap path, and is reported left alone', async () => {
    const recorded = world({ 100: { pgid: 100, holdsMarker: true, startMs: 1, startUnreadable: true }, 200: { pgid: 200, holdsMarker: true, startMs: 2, startUnreadable: true } }, {});
    const result = await reconcile(recorded);
    expect(recorded.signals).toEqual([]);
    expect([...result.leftAlonePids].sort()).toEqual([100, 200]);
    const unrecorded = world({ 200: { pgid: 200, holdsMarker: true, startMs: 2, startUnreadable: true } }, {});
    const warnings: string[] = [];
    await reapMarkedProcesses({ marker: markerFile(), killGraceMs: 1000, label: 'tool', onWarning: (message) => warnings.push(message), kill: unrecorded.kill, groupPort: unrecorded.groupPort, timing: instantTiming(), inspector: unrecorded.inspector });
    expect(unrecorded.signals).toEqual([]);
    expect(warnings.some((warning) => warning.includes('process 200 is still alive but could not be verified as belonging to this call'))).toBe(true);
  });
});
