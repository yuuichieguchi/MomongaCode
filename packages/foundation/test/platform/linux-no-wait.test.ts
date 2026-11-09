import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLinuxInspector } from '../../src/platform/linux-inspector.ts';
import { auxvLayoutOf } from '../../src/platform/linux-parsers.ts';
import type { UninspectableProcess } from '../../src/platform/inspector-types.ts';
import type { FileIdentity, ProcFs } from '../../src/platform/procfs.ts';
import { reapMarkedProcessesWithReport } from '../../src/process-markers.ts';
import { createUninspectableRegistry } from '../../src/uninspectable-registry.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform', 'linux-inspector.ts');

const LAYOUT = auxvLayoutOf('x64', 'LE');
const UID = 1000;
const STAT_SLEEP = '12 (sleep) S 4200 12 4200 34816 12 4194304 120 0 0 0 0 0 0 0 20 0 1 0 987654 5517312 189 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';

const auxv = (): Uint8Array => {
  const view = new DataView(new ArrayBuffer(32));
  view.setBigUint64(0, 17n, true);
  view.setBigUint64(8, 100n, true);
  return new Uint8Array(view.buffer);
};

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

const countingTiming = () => {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number): Promise<void> => {
      elapsed += ms;
    },
    elapsed: () => elapsed,
  };
};

type Process12 = { readableAfterLists: number; holdsMarker: boolean; alive: boolean };

const procfsWith = (marker: string, identity: FileIdentity, state: Process12): ProcFs => {
  let lists = 0;
  const text = async (file: string): Promise<string> => {
    if (file === '/proc/stat') return 'cpu  1 2 3 4\nbtime 1700000000\n';
    if (file === '/proc/12/stat' && state.alive) return STAT_SLEEP;
    if (file === '/proc/12/status' && state.alive) return `Name:\tsleep\nUid:\t${UID}\t${UID}\t${UID}\t${UID}\n`;
    throw errno('ENOENT');
  };
  return {
    readText: text,
    readBytes: async (file) => {
      if (file === '/proc/self/auxv') return auxv();
      throw errno('ENOENT');
    },
    list: async (directory) => {
      if (directory === '/proc') return state.alive ? ['12'] : [];
      if (directory === '/proc/12/fd' && state.alive) {
        lists += 1;
        if (lists <= state.readableAfterLists) throw errno('EACCES');
        return state.holdsMarker ? ['3'] : [];
      }
      throw errno('ENOENT');
    },
    identityOf: async (file) => {
      if (file === marker) return identity;
      if (file === '/proc/12/fd/3' && state.alive) return identity;
      throw errno('ENOENT');
    },
    birthMsOf: async () => 0,
  };
};

const fakeKill = (state: Process12) => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    if (signal !== 0) sent.push([target, signal]);
    if (target !== 12 && target !== -12) throw errno('ESRCH');
    if (!state.alive) throw errno('ESRCH');
    if (signal === 'SIGTERM' || signal === 'SIGKILL') state.alive = false;
  };
  return { kill, sent };
};

const markerFile = (): { marker: string; identity: FileIdentity } => {
  const marker = path.join(makeTemporaryDirectory(), 'marker');
  fs.writeFileSync(marker, '');
  return { marker, identity: { dev: 64769n, ino: 777n } };
};

describe('T11 Linux: the inspector waits for nothing', () => {
  it('reports a same-user process that refuses /proc/<pid>/fd at once, with zero time spent', async () => {
    const { marker, identity } = markerFile();
    const timing = countingTiming();
    const reported: UninspectableProcess[] = [];
    const inspector = createLinuxInspector({ procfs: procfsWith(marker, identity, { readableAfterLists: Infinity, holdsMarker: true, alive: true }), layout: LAYOUT, uid: UID, timing } as never);
    const result = await inspector.holdersOf(marker, { signal: new AbortController().signal } as never, (process: UninspectableProcess) => void reported.push(process));
    expect(result).toEqual({ kind: 'value', value: [] });
    expect(reported).toEqual([{ pid: 12, command: 'sleep', startTicks: '987654' }]);
    expect(timing.elapsed()).toBe(0);
  });

  it('linux-inspector.ts has no timing port and no probe deadline', () => {
    const text = fs.readFileSync(SOURCE, 'utf8');
    expect(text).not.toMatch(/PS_PROBE_TIMEOUT_MS|ProbeTiming|hostProbeTiming|timing/);
  });

  it('a reap re-asks under its own bound: a process that becomes readable on the third poll is listed and signalled', async () => {
    const { marker, identity } = markerFile();
    const state: Process12 = { readableAfterLists: 2, holdsMarker: true, alive: true };
    const timing = countingTiming();
    const { kill, sent } = fakeKill(state);
    const inspector = createLinuxInspector({ procfs: procfsWith(marker, identity, state), layout: LAYOUT, uid: UID, timing } as never);
    const report = await reapMarkedProcessesWithReport({ marker, killGraceMs: 300, label: 'tool', onWarning: () => undefined, kill: kill as never, timing, inspector, uninspectable: createUninspectableRegistry(), signal: new AbortController().signal });
    expect(sent).toContainEqual([12, 'SIGTERM']);
    expect(report.removed).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a reap of a process that never becomes readable ends within its own killGraceMs and reports it uninspectable, signalling nothing', async () => {
    const { marker, identity } = markerFile();
    const state: Process12 = { readableAfterLists: Infinity, holdsMarker: true, alive: true };
    const timing = countingTiming();
    const { kill, sent } = fakeKill(state);
    const inspector = createLinuxInspector({ procfs: procfsWith(marker, identity, state), layout: LAYOUT, uid: UID, timing } as never);
    const report = await reapMarkedProcessesWithReport({ marker, killGraceMs: 300, label: 'tool', onWarning: () => undefined, kill: kill as never, timing, inspector, uninspectable: createUninspectableRegistry(), signal: new AbortController().signal });
    expect(report.uninspectable).toEqual([{ pid: 12, command: 'sleep', startTicks: '987654' }]);
    expect(sent).toEqual([]);
    expect(report.removed).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    expect(timing.elapsed()).toBeLessThanOrEqual(2 * 300 + 2 * 25);
  });
});
