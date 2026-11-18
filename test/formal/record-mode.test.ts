import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemWaitTiming } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { createTempRoot, removeTempRoot } from '../../scripts/support/temp.ts';
import { checkEntry } from './check-entry.ts';
import type { CheckRequest } from './check-entry.ts';
import { completedOutput, holdsEntry, writeFile } from './fixtures.ts';
import { createJavaIdentityReader } from './reuse.ts';
import { measurementOfRun, recordModeOf, writeManifestRows } from './record.ts';
import type { TlcRun } from './manifest-reader.ts';

const TLC_STDOUT = completedOutput(3);

const fakeRun = (overrides: Partial<TlcRun> = {}): TlcRun => ({
  pid: 4242,
  exitCode: 0,
  signal: null,
  killedAtCpuBudget: false,
  metadir: '',
  stdout: TLC_STDOUT,
  stderr: 'run-lock: heavy run starts after waiting 2.00 s\n',
  usedCpuSeconds: 6.5,
  ...overrides,
});

const clockAt = (seconds: number[]): Timing => {
  const readings = [...seconds];
  return { ...systemWaitTiming, monotonicMs: () => (readings.length > 1 ? (readings.shift() as number) : (readings[0] ?? 0)) * 1000 };
};

describe('the record mode switch', () => {
  it('is off without the variable and on for 1', () => {
    expect(recordModeOf({})).toBe(false);
    expect(recordModeOf({ MOMONGA_TLC_RECORD: '0' })).toBe(false);
    expect(recordModeOf({ MOMONGA_TLC_RECORD: '1' })).toBe(true);
  });

  it('refuses any other value', () => {
    expect(() => recordModeOf({ MOMONGA_TLC_RECORD: 'yes' })).toThrow('MOMONGA_TLC_RECORD must be 1 or 0');
  });
});

describe('the measurement of a run the record mode ran itself', () => {
  it('takes the states from the output, the CPU from the run and the wall time without the lock wait', () => {
    expect(measurementOfRun(fakeRun(), 9.5)).toEqual({ distinctStates: 3, measuredSeconds: 7.5, measuredCpuSeconds: 6.5 });
  });
});

describe('the record mode of one row', () => {
  let root = '';
  let request: CheckRequest;

  beforeEach(() => {
    root = createTempRoot();
    writeFile(path.join(root, 'specs', 'tla', 'Tiny.tla'), '---- MODULE Tiny ----\n====\n');
    writeFile(path.join(root, 'specs', 'tla', 'Tiny.cfg'), 'INVARIANT Small\n');
    request = {
      entry: holdsEntry,
      script: 'unused',
      repoRoot: root,
      mode: 'off',
      env: {},
      store: { read: async () => ({ kind: 'miss', reason: 'no record' }), write: async () => ({ stored: false, reason: 'off' }), removeOrphans: async () => ({ removed: 0 }) },
      java: createJavaIdentityReader({ env: {} }),
      limitMs: 60000,
      now: () => new Date(0),
      timing: clockAt([100, 109.5]),
      loadAverage: () => 1.5,
      record: true,
      run: async () => fakeRun(),
    };
  });

  afterEach(() => {
    removeTempRoot(root);
  });

  it('hands back the measurement and the load at the start of a cold run that gave its verdict', async () => {
    const outcome = await checkEntry(request);
    expect(outcome).toMatchObject({ outcome: 'ran', problems: [], measurement: { distinctStates: 3, measuredSeconds: 7.5, measuredCpuSeconds: 6.5 }, loadAtStart: 1.5 });
  });

  it('hands back no measurement when the run gave a wrong verdict', async () => {
    const outcome = await checkEntry({ ...request, run: async () => fakeRun({ exitCode: 12, stdout: 'Error: Invariant Small is violated.' }) });
    expect(outcome).toMatchObject({ outcome: 'ran' });
    expect((outcome as { measurement?: unknown }).measurement).toBeUndefined();
  });

  it('hands back no measurement outside the record mode', async () => {
    const outcome = await checkEntry({ ...request, record: false });
    expect((outcome as { measurement?: unknown }).measurement).toBeUndefined();
  });
});

describe('the one write of the manifest', () => {
  let root = '';
  const manifest = (): string => path.join(root, 'manifest.json');

  beforeEach(() => {
    root = createTempRoot();
    fs.writeFileSync(manifest(), `${JSON.stringify({ format: 'f', entries: [{ config: 'A', n: 1 }, { config: 'B', n: 1 }, { config: 'C', n: 1 }] }, null, 2)}\n`);
  });

  afterEach(() => {
    removeTempRoot(root);
  });

  it('replaces the named rows in place, keeps the others and the order, and leaves no temporary file', () => {
    writeManifestRows(manifest(), [{ config: 'C', n: 2 }, { config: 'A', n: 2 }]);
    const written = JSON.parse(fs.readFileSync(manifest(), 'utf8')) as { format: string; entries: { config: string; n: number }[] };
    expect(written.format).toBe('f');
    expect(written.entries).toEqual([{ config: 'A', n: 2 }, { config: 'B', n: 1 }, { config: 'C', n: 2 }]);
    expect(fs.readdirSync(root)).toEqual(['manifest.json']);
  });

  it('keeps the file as it was when a named row is absent', () => {
    expect(() => writeManifestRows(manifest(), [{ config: 'Z', n: 2 }])).toThrow('Z has no row');
    expect(JSON.parse(fs.readFileSync(manifest(), 'utf8')).entries).toHaveLength(3);
  });
});
