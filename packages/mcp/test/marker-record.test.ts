import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostProcessGroupPort, readAttemptRecord, readMarkerGroup, reapMarkerDirectory, type AttemptRecord } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, testProcessInspector } from '@momonga/testkit';
import { eventually, groupExists, makeDir, rawConfig, startRaw } from './raw-transport.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const control = vi.hoisted(() => ({ recordsAtReap: [] as AttemptRecord[] }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...original,
    reapMarkedProcesses: async (...args: Parameters<typeof original.reapMarkedProcesses>) => {
      control.recordsAtReap.push(await original.readAttemptRecord(args[0].marker));
      return original.reapMarkedProcesses(...args);
    },
  };
});

beforeEach(() => {
  control.recordsAtReap = [];
});

const markerSetup = () => {
  const dir = path.join(makeDir(), 'markers');
  fs.mkdirSync(dir, { mode: 0o700 });
  const warnings: string[] = [];
  return { dir, warnings, markers: { dir, onWarning: (message: string) => void warnings.push(message) } };
};

const onlyMarkerIn = (dir: string): string => {
  const names = fs.readdirSync(dir);
  expect(names).toHaveLength(1);
  return path.join(dir, names[0] as string);
};

describe('the marker of an MCP stdio server is a group record written by the one marker writer', () => {
  it('holds an unspent attempt record, the process group and the job name the host gives the group', async () => {
    const { dir, markers } = markerSetup();
    const { request } = await startRaw({ config: rawConfig(), markers, closeGraceMs: 200 });
    const { pid } = (await request('pid')) as { pid: number };
    const marker = onlyMarkerIn(dir);

    const record = await readAttemptRecord(marker);
    expect(record).toEqual({ spent: { guard: false, sweep: false, startup: false, shutdown: false }, ignored: false });
    expect(await readMarkerGroup(marker)).toBe(pid);
    const name = hostProcessGroupPort().names?.nameOf(pid);
    expect(fs.readFileSync(marker, 'utf8').split('\n')[2]).toBe(name === undefined ? '' : `j${name}`);
  });

  it('a marker left by the transport of a dead generation is reaped by the sweep occasion', async () => {
    const { dir, markers } = markerSetup();
    const { request } = await startRaw({ config: rawConfig(), markers, closeGraceMs: 200 });
    const { pid } = (await request('pid')) as { pid: number };
    const written = fs.readFileSync(onlyMarkerIn(dir), 'utf8');
    const deadGeneration = path.join(makeDir(), 'g7', 'mcp');
    fs.mkdirSync(deadGeneration, { recursive: true, mode: 0o700 });
    const leftBehind = path.join(deadGeneration, path.basename(onlyMarkerIn(dir)));
    fs.writeFileSync(leftBehind, written, { mode: 0o600 });
    await killGroupsForCleanup([pid]);
    await eventually(async () => !(await groupExists(pid)), 'the server group to end');

    const outcome = await reapMarkerDirectory({ inspector: testProcessInspector(), dir: deadGeneration, killGraceMs: 200, label: 'mcp', onWarning: () => undefined, signal: new AbortController().signal, occasion: 'sweep' });

    expect(outcome).toEqual({ reaped: 1, kept: 0 });
    expect(fs.readdirSync(deadGeneration)).toEqual([]);
  });

  it('the reap at close claims the shutdown retry in the record before it reaps', async () => {
    const { dir, markers } = markerSetup();
    const { transport } = await startRaw({ config: rawConfig(), markers, closeGraceMs: 200 });
    expect(fs.readdirSync(dir)).toHaveLength(1);

    await transport.close();

    expect(control.recordsAtReap).toHaveLength(1);
    expect(control.recordsAtReap[0]?.spent).toEqual({ guard: false, sweep: false, startup: false, shutdown: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
