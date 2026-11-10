import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProbeFailedError, markerReapClockBoundMs, createUninspectableRegistry, findHolders, probeFailed, reapMarkedProcesses, reapMarkedProcessesWithReport, reapMarkerDirectory, reportUninspectableOnce } from '@momonga/foundation';
import type { ProbeResult, ProcessInspector, UninspectableProcess } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, drivenReapTiming, fakeReapTiming, waitFor, withTempDir } from '@momonga/testkit';

const transient = probeFailed({ kind: 'errno', code: 'EMFILE', detail: 'too many open files' });
const deterministic = probeFailed({ kind: 'exit', exitCode: 2, detail: 'lsof exited with 2: bad' });

const inspectorOf = (holders: () => ProbeResult<number[]>): ProcessInspector => ({
  startTimeOf: async () => ({ kind: 'gone' }),
  holdersOf: async () => holders(),
  groupsOf: async () => ({ kind: 'value', value: new Map() }),
  markerState: async () => 'free',
});

const LIVE = { signal: new AbortController().signal };

const timing = () => {
  const clock = createFakeClock(0);
  return fakeReapTiming(clock, createFakeTimers(clock));
};

const marker = (context: Parameters<typeof withTempDir>[0]): string => {
  const file = path.join(withTempDir(context), 'marker');
  fs.writeFileSync(file, '', { mode: 0o600 });
  return file;
};

describe('findHolders', () => {
  it('lists the holders other than the current process', async () => {
    expect(await findHolders('/m', { ...LIVE, inspector: inspectorOf(() => ({ kind: 'value', value: [process.pid, 77] })) })).toEqual([77]);
  });

  it('reports a missing marker as having no holders', async () => {
    expect(await findHolders('/m', { ...LIVE, inspector: inspectorOf(() => ({ kind: 'gone' })) })).toEqual([]);
  });

  it('throws a typed error for a failed probe instead of reporting no holders', async () => {
    const failure = await findHolders('/m', { ...LIVE, inspector: inspectorOf(() => transient) }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProbeFailedError);
    expect(failure).toMatchObject({ probeCause: 'transient', evidence: { code: 'EMFILE' } });
  });
});

const inspectorReporting = (processes: readonly UninspectableProcess[]): ProcessInspector => ({
  startTimeOf: async () => ({ kind: 'gone' }),
  holdersOf: async (_marker, _options, report) => {
    for (const process of processes) report?.(process);
    return { kind: 'value', value: [] };
  },
  groupsOf: async () => ({ kind: 'value', value: new Map() }),
  markerState: async () => (processes.length > 0 ? 'held' : 'free'),
});

const aliveRegistry = () => createUninspectableRegistry({ isAlive: () => true });

const ssh = { pid: 77, command: 'ssh-agent', startedAt: 1001n };
const otherSsh = { pid: 77, command: 'ssh-agent', startedAt: 1002n };

describe('findHolders and reportUninspectableOnce with a process that cannot be inspected', () => {
  it('hands the process to the callback and still lists the holders', async () => {
    const seen: UninspectableProcess[] = [];
    const inspector = inspectorReporting([ssh]);
    expect(await findHolders('/m', { ...LIVE, inspector, onUninspectable: (process) => void seen.push(process) })).toEqual([]);
    expect(seen).toEqual([ssh]);
  });

  it('warns once per context, pid and start tick, and again for a new process with the same pid', () => {
    const warnings: string[] = [];
    const registry = aliveRegistry();
    const report = reportUninspectableOnce((message) => void warnings.push(message), 'tool marker /m', registry);
    const fresh = { pid: 9001, command: 'sshd', startedAt: 5n };
    report(fresh);
    report(fresh);
    reportUninspectableOnce((message) => void warnings.push(message), 'background job j1', registry)(fresh);
    report({ ...fresh, startedAt: 6n });
    expect(warnings).toEqual([
      'tool marker /m: process 9001 (sshd) could not be inspected, so it was left alone',
      'background job j1: process 9001 (sshd) could not be inspected, so it was left alone',
      'tool marker /m: process 9001 (sshd) could not be inspected, so it was left alone',
    ]);
  });
});

describe('reapMarkedProcessesWithReport with a process that cannot be inspected', () => {
  it('keeps the marker, signals nothing, and names the process once as one that could not be inspected', async (context) => {
    const file = marker(context);
    const warnings: string[] = [];
    const result = await reapMarkedProcessesWithReport({
      marker: file,
      killGraceMs: 1000,
      label: 'mcp',
      onWarning: (message) => void warnings.push(message),
      timing: timing(),
      inspector: inspectorReporting([ssh]),
      uninspectable: aliveRegistry(),
    });
    expect(result).toEqual({ removed: false, stopped: false, uninspectable: [ssh] });
    expect(fs.existsSync(file)).toBe(true);
    expect(warnings).toEqual([`mcp marker ${file}: process 77 (ssh-agent) could not be inspected, so it was left alone`]);
  });

  it('keeps the marker in the same way when the recorded group is reconciled', async (context) => {
    const file = marker(context);
    const warnings: string[] = [];
    const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const result = await reapMarkedProcessesWithReport({
      marker: file,
      pgid: 2_000_000,
      killGraceMs: 1000,
      label: 'mcp',
      onWarning: (message) => void warnings.push(message),
      timing: timing(),
      kill: () => {
        throw gone;
      },
      inspector: inspectorReporting([otherSsh]),
      uninspectable: aliveRegistry(),
    });
    expect(result).toEqual({ removed: false, stopped: false, uninspectable: [otherSsh] });
    expect(fs.existsSync(file)).toBe(true);
    expect(warnings).toEqual([`mcp marker ${file}: process 77 (ssh-agent) could not be inspected, so it was left alone`]);
  });

  it('does not repeat the warning for a process it already named at the same marker', async (context) => {
    const warnings: string[] = [];
    const file = marker(context);
    const registry = aliveRegistry();
    for (let round = 0; round < 2; round += 1) {
      fs.writeFileSync(file, '', { mode: 0o600 });
      await reapMarkedProcessesWithReport({
        marker: file,
        killGraceMs: 1000,
        label: 'tool',
        onWarning: (message) => void warnings.push(message),
        timing: timing(),
        inspector: inspectorReporting([{ pid: 4242, command: 'ssh-agent', startedAt: 77n }]),
        uninspectable: registry,
      });
    }
    expect(warnings).toHaveLength(1);
  });

  it('names the same process again for another marker and another caller', async (context) => {
    const warnings: string[] = [];
    const registry = aliveRegistry();
    const first = marker(context);
    const second = marker(context);
    for (const [label, file] of [['tool', first], ['mcp', second]] as const) {
      await reapMarkedProcessesWithReport({
        marker: file,
        killGraceMs: 1000,
        label,
        onWarning: (message) => void warnings.push(message),
        timing: timing(),
        inspector: inspectorReporting([{ pid: 4242, command: 'ssh-agent', startedAt: 77n }]),
        uninspectable: registry,
      });
    }
    expect(warnings).toEqual([
      `tool marker ${first}: process 4242 (ssh-agent) could not be inspected, so it was left alone`,
      `mcp marker ${second}: process 4242 (ssh-agent) could not be inspected, so it was left alone`,
    ]);
  });

  it('says nothing when every process could be inspected', async (context) => {
    const file = marker(context);
    const warnings: string[] = [];
    const result = await reapMarkedProcessesWithReport({
      marker: file,
      killGraceMs: 1000,
      label: 'mcp',
      onWarning: (message) => void warnings.push(message),
      timing: timing(),
      inspector: inspectorReporting([]),
    });
    expect(result).toEqual({ removed: true, stopped: false, uninspectable: [] });
    expect(warnings).toEqual([]);
  });
});

describe('reapMarkedProcesses with a probe that fails', () => {
  it('keeps the marker and throws when the holders cannot be listed deterministically', async (context) => {
    const file = marker(context);
    await expect(
      reapMarkedProcesses({ marker: file, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, timing: timing(), inspector: inspectorOf(() => deterministic) }),
    ).rejects.toMatchObject({ probeCause: 'deterministic' });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('retries a transient failure until it clears and then removes the marker', async (context) => {
    const file = marker(context);
    let calls = 0;
    const inspector = inspectorOf(() => (++calls <= 3 ? transient : { kind: 'value', value: [] }));
    const result = await reapMarkedProcesses({ marker: file, killGraceMs: 1000, label: 'daemon', onWarning: () => undefined, timing: timing(), inspector });
    expect(result).toEqual({ removed: true });
    expect(calls).toBeGreaterThan(3);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('gives up on a transient failure that outlasts the grace and keeps the marker', async (context) => {
    const file = marker(context);
    await expect(
      reapMarkedProcesses({ marker: file, killGraceMs: 200, label: 'daemon', onWarning: () => undefined, timing: timing(), inspector: inspectorOf(() => transient) }),
    ).rejects.toMatchObject({ probeCause: 'transient' });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('never removes the marker of a live holder just because the final listing failed', async (context) => {
    const file = marker(context);
    let calls = 0;
    const inspector = inspectorOf(() => (++calls <= 2 ? { kind: 'value', value: [] } : deterministic));
    await expect(
      reapMarkedProcesses({ marker: file, killGraceMs: 200, label: 'daemon', onWarning: () => undefined, timing: timing(), inspector }),
    ).rejects.toMatchObject({ probeCause: 'deterministic' });
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('the recorded group of a marker', () => {
  it('reads a recorded group of at most 32 bytes and ignores a larger file', async (context) => {
    const file = marker(context);
    fs.writeFileSync(file, `${'9'.repeat(5000)}\n`);
    const result = await reapMarkedProcesses({
      marker: file,
      killGraceMs: 200,
      label: 'daemon',
      onWarning: () => undefined,
      timing: timing(),
      inspector: inspectorOf(() => ({ kind: 'value', value: [] })),
    });
    expect(result).toEqual({ removed: true });
  });
});

describe('reaping on time that only the test drives', () => {
  it('shows two markers waiting at the same time and a holder that never leaves, instead of finishing inside a synchronous sleep', async (context) => {
    const directory = withTempDir(context);
    fs.writeFileSync(path.join(directory, 'a'), '', { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'b'), '', { mode: 0o600 });
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const warnings: string[] = [];
    const signalled: number[] = [];
    const reaping = reapMarkerDirectory({
      signal: new AbortController().signal,
      dir: directory,
      killGraceMs: 100,
      label: 'daemon',
      onWarning: (message) => warnings.push(message),
      kill: (pid) => void signalled.push(pid),
      timing: drivenReapTiming(clock, timers),
      inspector: inspectorOf(() => ({ kind: 'value', value: [4242] })),
    });
    let settled = false;
    void reaping.then(() => (settled = true));
    await waitFor(() => timers.pending().length === 2, { description: 'both markers waiting out the grace at once' });
    expect(settled).toBe(false);
    expect(clock.now()).toBe(0);
    for (let step = 0; step < markerReapClockBoundMs(100) / 25 && !settled; step += 1) {
      timers.advance(25);
      await waitFor(() => settled || timers.pending().length === 2, { description: 'the markers to poll again' });
    }
    expect(await reaping).toEqual({ reaped: 0, kept: 2 });
    expect(warnings).toHaveLength(2);
    expect(fs.readdirSync(directory).sort()).toEqual(['a', 'b']);
  });
});
