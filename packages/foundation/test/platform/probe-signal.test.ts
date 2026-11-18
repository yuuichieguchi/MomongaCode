import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDarwinInspector } from '../../src/platform/darwin-inspector.ts';
import { Deadline } from '../../src/deadline.ts';
import { createProcessInspector, hostInspectorPorts } from '../../src/platform/process-inspector.ts';
import { fixedCapability, silentRunner, slowRunner, virtualTiming, settlementOf } from '../support/probe-fakes.ts';
import type { RecordedCommand } from '../support/probe-fakes.ts';
import { testLocks } from '@momonga/testkit';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform');

const LSOF_TWO_HOLDERS = { exitCode: 0, stdout: '4242\n4243\n', stderr: '' };

const darwinWith = (run: Parameters<typeof createDarwinInspector>[0]['run']) =>
  createProcessInspector('lsof', { ...hostInspectorPorts(testLocks().capability), run, capability: fixedCapability('unenforced') });

describe('T1 the listing path does not depend on how long the listing takes', () => {
  it.for([110, 2100, 6000])('holdersOf answers the same holders when lsof takes %i ms', async (latencyMs) => {
    const calls: RecordedCommand[] = [];
    const inspector = darwinWith(slowRunner(latencyMs, LSOF_TWO_HOLDERS, calls));
    const result = await inspector.holdersOf('/m/marker', { signal: new AbortController().signal });
    expect(result).toEqual({ kind: 'value', value: [4242, 4243] });
    expect(calls.map((call) => call.options.timeoutMs)).toEqual([undefined]);
  });
});

describe('T4 no private probe bound; every probe ends with the signal of its caller', () => {
  it('(a) darwin-inspector.ts carries no timeoutMs and the host ports carry no startTimeoutMs', () => {
    expect(fs.readFileSync(path.join(SOURCE, 'darwin-inspector.ts'), 'utf8')).not.toMatch(/timeoutMs|TimeoutMs/);
    expect(Object.keys(hostInspectorPorts(testLocks().capability))).not.toContain('startTimeoutMs');
  });

  it('(b) a listing that never answers rejects exactly when the caller aborts at its deadline, and its child is killed', async () => {
    const timing = virtualTiming();
    const calls: RecordedCommand[] = [];
    const inspector = darwinWith(silentRunner(calls));
    const { signal } = Deadline.after(5000, timing);
    const listing = inspector.holdersOf('/m/marker', { signal });
    const listed = settlementOf(listing);
    await timing.advanceAsync(4999);
    expect(listed.current().state).toBe('pending');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
    await timing.advanceAsync(1);
    expect(await listing).toMatchObject({ kind: 'failed' });
    expect(calls[0]?.killed).toBe(true);
  });

  it('(b) startTimeOf and groupsOf pass the caller signal to the runner and stop when it aborts', async () => {
    const calls: RecordedCommand[] = [];
    const inspector = darwinWith(silentRunner(calls));
    const controller = new AbortController();
    const start = inspector.startTimeOf(42, { signal: controller.signal });
    const groups = inspector.groupsOf([42], [], { signal: controller.signal });
    controller.abort();
    expect(await start).toMatchObject({ kind: 'failed' });
    expect(await groups).toMatchObject({ kind: 'failed' });
    expect(calls.map((call) => [call.options.signal?.aborted, call.killed])).toEqual([
      [true, true],
      [true, true],
    ]);
  });
});
