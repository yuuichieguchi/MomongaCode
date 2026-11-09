import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessInspector } from '@momonga/foundation';
import { createMarkerSettle, settleFinishedCommand } from '../src/marker-settle.ts';

type Entry = { pgid: number; startUnreadable?: boolean };

const sceneOf = (table: Record<number, Entry>) => {
  const processes = new Map(Object.entries(table).map(([pid, entry]) => [Number(pid), entry]));
  const signals: Array<{ target: number; signal: NodeJS.Signals }> = [];
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    const hit = target < 0 ? [...processes].filter(([, entry]) => entry.pgid === -target).map(([pid]) => pid) : processes.has(target) ? [target] : [];
    if (signal !== 0) signals.push({ target, signal });
    if (hit.length === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    if (signal !== 0) for (const pid of hit) processes.delete(pid);
  };
  const inspector = {
    startTimeOf: async (pid: number) => {
      const entry = processes.get(pid);
      if (entry === undefined) return { kind: 'gone' };
      if (entry.startUnreadable === true) return { kind: 'failed', cause: 'deterministic', evidence: { kind: 'exit', exitCode: 1, detail: 'ps exited with 1' } };
      return { kind: 'value', value: pid };
    },
    holdersOf: async () => ({ kind: 'value', value: [...processes.keys()] }),
    groupsOf: async (pids: readonly number[]) => ({ kind: 'value', value: new Map(pids.filter((pid) => processes.has(pid)).map((pid) => [pid, processes.get(pid)!.pgid])) }),
    markerState: async () => (processes.size === 0 ? 'free' : 'held'),
  } as unknown as ProcessInspector;
  return { signals, kill, inspector };
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const settleFor = (scene: ReturnType<typeof sceneOf>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-report-'));
  dirs.push(dir);
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, '', { mode: 0o600 });
  let now = 0;
  const timing = { now: () => now, sleep: async (ms: number) => void (now += ms) };
  return createMarkerSettle({ marker, mode: 'listed', inspector: scene.inspector, kill: scene.kill, timing, killGraceMs: 100, onWarning: () => undefined });
};

const finished = { pgid: 100, exit: { code: 0, signal: null }, signal: new AbortController().signal };

describe('the note after a finished command reports only the processes the reap proved and signalled, and names the ones it left alone', () => {
  it('a holder whose start time cannot be read is not counted as terminated and is named as left alone', async () => {
    const scene = sceneOf({ 200: { pgid: 200, startUnreadable: true } });
    const lines = await settleFinishedCommand(settleFor(scene), finished);
    expect(scene.signals).toEqual([]);
    expect(lines.join(' ')).not.toContain('Terminated');
    expect(lines.join(' ')).toContain('Still running but no longer verified as belonging to this call, so left alone: process 200.');
  });

  it('counts the proved holder it signalled and names the unproved one it left alone', async () => {
    const scene = sceneOf({ 200: { pgid: 200 }, 300: { pgid: 300, startUnreadable: true } });
    const lines = await settleFinishedCommand(settleFor(scene), finished);
    expect(scene.signals).toEqual([{ target: 200, signal: 'SIGTERM' }]);
    expect(lines).toContain('Terminated 1 process(es) that outlived the command.');
    expect(lines.join(' ')).toContain('so left alone: process 300.');
  });
});
