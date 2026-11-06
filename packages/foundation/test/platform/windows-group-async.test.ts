import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as foundation from '../../src/index.ts';
import { isProcessAlive } from '../../src/process-alive.ts';
import { createProcessGroupPort } from '../../src/platform/group-port.ts';
import { deadlineSignal } from '../../src/platform/probe-timing.ts';
import { pendingOrSettled, silentRunner, virtualTiming } from '../support/probe-fakes.ts';
import type { RecordedCommand } from '../support/probe-fakes.ts';

const PLATFORM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform');

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows' };

const sourcesOf = (dir: string): Array<[string, string]> => fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);

describe('T9 Windows group control is asynchronous and ends with the caller signal', () => {
  it('alive on a PowerShell that never answers rejects exactly at the deadline of the caller, and its child is killed', async () => {
    const timing = virtualTiming();
    const calls: RecordedCommand[] = [];
    const port = createProcessGroupPort('win32', { run: silentRunner(calls), env: WINDOWS_ENV } as never);
    const signal = deadlineSignal(timing, 5000);
    const asked = Promise.resolve().then(() => port.alive(4242, { signal } as never));
    await timing.advanceTo(4999);
    expect((await pendingOrSettled(asked)).state).toBe('pending');
    await timing.advanceTo(5000);
    expect((await pendingOrSettled(asked)).state).toBe('rejected');
    expect(calls.map((call) => [call.options.signal?.aborted, call.killed])).toEqual([[true, true]]);
  });

  it('signal on a PowerShell that never answers rejects when the caller aborts, and its child is killed', async () => {
    const calls: RecordedCommand[] = [];
    const port = createProcessGroupPort('win32', { run: silentRunner(calls), env: WINDOWS_ENV } as never);
    const controller = new AbortController();
    const sent = Promise.resolve().then(() => port.signal(4242, 'SIGTERM', { signal: controller.signal } as never));
    expect((await pendingOrSettled(sent)).state).toBe('pending');
    controller.abort();
    expect((await pendingOrSettled(sent)).state).toBe('rejected');
    expect(calls[0]?.killed).toBe(true);
  });

  it('keeps no synchronous runner and no private Windows probe timeout', () => {
    expect(Object.keys(foundation)).not.toContain('nodeSyncCommandRunner');
    expect(Object.keys(foundation)).not.toContain('WINDOWS_PROBE_TIMEOUT_MS');
    for (const [name, text] of sourcesOf(PLATFORM)) {
      expect({ name, sync: /execFileSync|nodeSyncCommandRunner|SyncCommandRunner|WINDOWS_PROBE_TIMEOUT_MS/.test(text) }).toEqual({ name, sync: false });
    }
  });

  it('isProcessAlive of a positive pid stays synchronous', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
