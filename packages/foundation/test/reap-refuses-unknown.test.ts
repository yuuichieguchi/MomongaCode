import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeFailed } from '../src/platform/inspector-types.ts';
import type { ProcessInspector } from '../src/platform/inspector-types.ts';
import { reapMarkedProcesses, reconcileProcessGroup } from '../src/process-markers.ts';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';

const failure = probeFailed({ kind: 'exit', exitCode: 2, detail: 'lsof exited with 2: injected' });

const failingInspector: ProcessInspector = {
  startTimeOf: async () => failure,
  holdersOf: async () => failure,
  groupsOf: async () => failure,
} as unknown as ProcessInspector;

const recordingKill = () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    sent.push([target, signal]);
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  };
  return { kill, signals: () => sent.filter(([, signal]) => signal !== 0) };
};

const timing = { now: () => 0, sleep: async () => undefined };

describe('T5 the reap paths still refuse when the holder state is unknown (invariant I2)', () => {
  it('reconcileProcessGroup resolves with could not check on a failing listing and signals nothing', async () => {
    const { kill, signals } = recordingKill();
    const marker = path.join(makeTemporaryDirectory(), 'marker');
    fs.writeFileSync(marker, '');
    const result = await reconcileProcessGroup({ pgid: 424242, marker }, { inspector: failingInspector, kill: kill as never, timing, signal: new AbortController().signal });
    expect(result.output.startsWith('MomongaCode could not check whether a process started by the interrupted command is still running (')).toBe(true);
    expect(result.output).toContain('injected');
    expect(result.stopped).toBe(false);
    expect(signals()).toEqual([]);
  });

  it('reapMarkedProcesses rejects on a failing listing, keeps the marker and signals nothing', async () => {
    const { kill, signals } = recordingKill();
    const marker = path.join(makeTemporaryDirectory(), 'marker');
    fs.writeFileSync(marker, '424242\n');
    await expect(
      reapMarkedProcesses({ marker, killGraceMs: 300, label: 'tool', onWarning: () => undefined, inspector: failingInspector, kill: kill as never, timing, signal: new AbortController().signal }),
    ).rejects.toThrow('injected');
    expect(fs.existsSync(marker)).toBe(true);
    expect(signals()).toEqual([]);
  });
});
