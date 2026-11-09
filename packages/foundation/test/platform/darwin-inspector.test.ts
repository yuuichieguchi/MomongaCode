import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../src/platform/command-runner.ts';
import { createDarwinInspector } from '../../src/platform/darwin-inspector.ts';
import { defaultProcessInspector } from '../../src/platform/process-inspector.ts';
import { REAL_PROCESS_TEST_TIMEOUT_MS, spawnTracked, withTempDir } from '@momonga/testkit';

const LIVE = { signal: new AbortController().signal };

const result = (partial: Partial<CommandResult>): CommandResult => ({ exitCode: 0, stdout: '', stderr: '', ...partial });

const inspectorReturning = (outcome: Partial<CommandResult> | Error, calls: Array<{ file: string; args: readonly string[] }> = []) =>
  createDarwinInspector({
    run: async (file, args) => {
      calls.push({ file, args });
      if (outcome instanceof Error) throw outcome;
      return result(outcome);
    },
  });

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });
const timedOut = (): Error => Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGKILL' });
const LSOF_MISSING = 'lsof: status error on /m/marker: No such file or directory\nlsof 4.91\n latest revision: ftp://example\n usage: [-?abhlnNoOPRtUvVX]\n';

describe('darwin inspector: holdersOf', () => {
  it('asks lsof for pids only, without warnings', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    await inspectorReturning({ exitCode: 1 }, calls).holdersOf('/m/marker', LIVE);
    expect(calls).toEqual([{ file: '/usr/sbin/lsof', args: ['-w', '-t', '--', '/m/marker'] }]);
  });

  it('lists the holders printed with exit 0', async () => {
    expect(await inspectorReturning({ stdout: '12\n13\n' }).holdersOf('/m/marker', LIVE)).toEqual({ kind: 'value', value: [12, 13] });
  });

  it('reads exit 1 with no output at all as no holders', async () => {
    expect(await inspectorReturning({ exitCode: 1 }).holdersOf('/m/marker', LIVE)).toEqual({ kind: 'value', value: [] });
  });

  it('reads exit 1 with the status error of the marker itself as a missing marker', async () => {
    expect(await inspectorReturning({ exitCode: 1, stderr: LSOF_MISSING }).holdersOf('/m/marker', LIVE)).toEqual({ kind: 'gone' });
  });

  it('does not read exit 1 with any other error text as no holders', async () => {
    expect(await inspectorReturning({ exitCode: 1, stderr: 'lsof: WARNING: something else went wrong\n' }).holdersOf('/m/marker', LIVE)).toEqual({
      kind: 'failed',
      cause: 'deterministic',
      evidence: { kind: 'exit', exitCode: 1, detail: 'lsof exited with 1: lsof: WARNING: something else went wrong' },
    });
  });

  it('does not read a status error for another path as a missing marker', async () => {
    expect(await inspectorReturning({ exitCode: 1, stderr: LSOF_MISSING.replace('/m/marker', '/m/other') }).holdersOf('/m/marker', LIVE)).toMatchObject({ kind: 'failed' });
  });

  it('classifies a spawn failure by errno and a timeout as transient', async () => {
    expect(await inspectorReturning(errno('EAGAIN')).holdersOf('/m/marker', LIVE)).toMatchObject({ kind: 'failed', cause: 'transient', evidence: { kind: 'errno', code: 'EAGAIN' } });
    expect(await inspectorReturning(errno('ENOENT')).holdersOf('/m/marker', LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'errno', code: 'ENOENT' } });
    expect(await inspectorReturning(timedOut()).holdersOf('/m/marker', LIVE)).toMatchObject({ kind: 'failed', cause: 'transient', evidence: { kind: 'timeout' } });
  });

  it('reports exit 0 with output that is not a pid list as unparseable', async () => {
    expect(await inspectorReturning({ stdout: 'COMMAND PID\nnode 12\n' }).holdersOf('/m/marker', LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'unparseable' } });
    expect(await inspectorReturning({ stdout: '' }).holdersOf('/m/marker', LIVE)).toMatchObject({ kind: 'failed', evidence: { kind: 'unparseable' } });
  });
});

describe('darwin inspector: startTimeOf', () => {
  it('parses the start time as UTC', async () => {
    expect(await inspectorReturning({ stdout: 'Mon Nov  2 10:00:00 2026\n' }).startTimeOf(42, LIVE)).toEqual({ kind: 'value', value: Date.parse('2026-11-02T10:00:00Z') });
  });

  it('reads exit 1 without any output as a process that is gone', async () => {
    expect(await inspectorReturning({ exitCode: 1 }).startTimeOf(42, LIVE)).toEqual({ kind: 'gone' });
  });

  it('does not read a failing ps as a process that is gone', async () => {
    expect(await inspectorReturning({ exitCode: 1, stderr: 'ps: illegal option\n' }).startTimeOf(42, LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'exit' } });
    expect(await inspectorReturning({ exitCode: 2 }).startTimeOf(42, LIVE)).toMatchObject({ kind: 'failed', evidence: { kind: 'exit', exitCode: 2 } });
  });

  it('classifies a spawn failure and a timeout, never as gone', async () => {
    expect(await inspectorReturning(errno('EAGAIN')).startTimeOf(42, LIVE)).toMatchObject({ kind: 'failed', cause: 'transient' });
    expect(await inspectorReturning(timedOut()).startTimeOf(42, LIVE)).toMatchObject({ kind: 'failed', cause: 'transient' });
  });

  it('reports a garbled start time as unparseable', async () => {
    expect(await inspectorReturning({ stdout: 'not a date\n' }).startTimeOf(42, LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic', evidence: { kind: 'unparseable' } });
  });
});

describe('darwin inspector: groupsOf', () => {
  it('maps pids to groups', async () => {
    expect(await inspectorReturning({ stdout: '  12   12\n  13   12\n' }).groupsOf([12, 13], [], LIVE)).toEqual({
      kind: 'value',
      value: new Map([
        [12, 12],
        [13, 12],
      ]),
    });
  });

  it('reads exit 1 without output as none of the pids existing', async () => {
    expect(await inspectorReturning({ exitCode: 1 }).groupsOf([12], [], LIVE)).toEqual({ kind: 'value', value: new Map() });
  });

  it('does not run ps for an empty list', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    expect(await inspectorReturning({}, calls).groupsOf([], [], LIVE)).toEqual({ kind: 'value', value: new Map() });
    expect(calls).toEqual([]);
  });

  it('reports a row it cannot parse as unparseable instead of dropping it', async () => {
    expect(await inspectorReturning({ stdout: '12 12\nbroken row\n' }).groupsOf([12], [], LIVE)).toMatchObject({ kind: 'failed', evidence: { kind: 'unparseable' } });
  });

  it('does not read exit 1 with error text as none existing', async () => {
    expect(await inspectorReturning({ exitCode: 1, stderr: 'ps: error\n' }).groupsOf([12], [], LIVE)).toMatchObject({ kind: 'failed', cause: 'deterministic' });
  });
});

describe.skipIf(process.platform !== 'darwin')('darwin inspector against the real lsof and ps', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  const holder = (context: Parameters<typeof withTempDir>[0], marker: string) => {
    const fd = fs.openSync(marker, 'r');
    try {
      return spawnTracked(context, process.execPath, ['-e', 'setInterval(() => undefined, 60000)'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    } finally {
      fs.closeSync(fd);
    }
  };

  it('finds the holder of a marker, finds no holder once it is gone, and calls a missing marker gone', async (context) => {
    const marker = path.join(withTempDir(context), 'marker');
    fs.writeFileSync(marker, '');
    expect(await defaultProcessInspector().holdersOf(marker, LIVE)).toEqual({ kind: 'value', value: [] });
    const child = holder(context, marker);
    expect(await defaultProcessInspector().holdersOf(marker, LIVE)).toEqual({ kind: 'value', value: [child.pid] });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(await defaultProcessInspector().holdersOf(marker, LIVE)).toEqual({ kind: 'value', value: [] });
    fs.rmSync(marker);
    expect(await defaultProcessInspector().holdersOf(marker, LIVE)).toEqual({ kind: 'gone' });
  });

  it('reads the start time of a live process and calls a dead pid gone', async (context) => {
    const child = spawnTracked(context, process.execPath, ['-e', 'setInterval(() => undefined, 60000)'], { stdio: 'ignore' });
    const live = await defaultProcessInspector().startTimeOf(child.pid, LIVE);
    expect(live.kind).toBe('value');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(await defaultProcessInspector().startTimeOf(child.pid, LIVE)).toEqual({ kind: 'gone' });
  });
});
