import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProbeFailedError, findHolders, probeFailed, reapMarkedProcesses, reapMarkerDirectory } from '@momonga/foundation';
import type { ProbeResult, ProcessInspector } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, drivenReapTiming, fakeReapTiming, waitFor, withTempDir } from '@momonga/testkit';

const transient = probeFailed({ kind: 'errno', code: 'EMFILE', detail: 'too many open files' });
const deterministic = probeFailed({ kind: 'exit', exitCode: 2, detail: 'lsof exited with 2: bad' });

const inspectorOf = (holders: () => ProbeResult<number[]>): ProcessInspector => ({
  startTimeOf: async () => ({ kind: 'gone' }),
  holdersOf: async () => holders(),
  groupsOf: async () => ({ kind: 'value', value: new Map() }),
});

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
    expect(await findHolders('/m', inspectorOf(() => ({ kind: 'value', value: [process.pid, 77] })))).toEqual([77]);
  });

  it('reports a missing marker as having no holders', async () => {
    expect(await findHolders('/m', inspectorOf(() => ({ kind: 'gone' })))).toEqual([]);
  });

  it('throws a typed error for a failed probe instead of reporting no holders', async () => {
    const failure = await findHolders('/m', inspectorOf(() => transient)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProbeFailedError);
    expect(failure).toMatchObject({ probeCause: 'transient', evidence: { code: 'EMFILE' } });
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
    for (let step = 0; step < 20 && !settled; step += 1) {
      timers.advance(25);
      await waitFor(() => settled || timers.pending().length === 2, { description: 'the markers to poll again' });
    }
    expect(await reaping).toEqual({ reaped: 0, kept: 2 });
    expect(warnings).toHaveLength(2);
    expect(fs.readdirSync(directory).sort()).toEqual(['a', 'b']);
  });
});
