import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STOP_VALUES, generationLayout, writeStopRecord } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { daemonStatus } from '../src/commands/daemon.ts';
import type { CliPorts } from '../src/ports.ts';
import { setupGenerations } from './generations-harness.ts';
import { testKernelLock } from '@momonga/testkit';

const STOP_VALUES: StopValues = { closeGraceMs: 2000, managedServerStopGraceMs: 500, drainTimeoutMs: 7000, mcpCloseGraceMs: 0 };

describe('momonga daemon status reads its stop values the way the stop does (cli-commands-C20)', () => {
  it('reports an invalid user settings file once with a notice and shows the default values', async (context) => {
    const { home, paths, start, ports, stdout, stderr } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 2, pid: 4002 });
    await writeStopRecord(generationLayout(home, 2).stopRecord, 2, STOP_VALUES, testKernelLock());
    fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), '{ not json');

    expect(await daemonStatus({ ...ports, interrupt: new AbortController().signal } as unknown as CliPorts, paths, { json: false })).toBe(0);

    expect(stdout.chunks.join('')).toContain(`settings now: gateway.closeGraceMs ${DEFAULT_STOP_VALUES.closeGraceMs}`);
    expect(stderr.chunks.join('').match(/the default values were used/g)).toHaveLength(1);
  });

  it('shows the retention period and the last sweep of the serving runtime', async (context) => {
    const { paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 2, pid: 4002, reports: { retention: { days: 30, lastSweep: { at: '2026-11-17T00:00:00.000Z', sessionsDeleted: 2, runsPurged: 3, blobsCollected: 4 } } } });

    expect(await daemonStatus({ ...ports, interrupt: new AbortController().signal } as unknown as CliPorts, paths, { json: false })).toBe(0);

    expect(stdout.chunks.join('')).toContain('  retention: 30 days, last sweep at 2026-11-17T00:00:00.000Z: 2 sessions deleted, 3 runs purged, 4 blobs collected\n');
  });

  it('prints with --json the values the text shows', async (context) => {
    const { home, paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 2, pid: 4002 });
    await writeStopRecord(generationLayout(home, 2).stopRecord, 2, STOP_VALUES, testKernelLock());

    expect(await daemonStatus({ ...ports, interrupt: new AbortController().signal } as unknown as CliPorts, paths, { json: true })).toBe(0);

    const document = JSON.parse(stdout.chunks.join('')) as { running: boolean; generations: { role: string; version: string; pid: number; lastStop: StopValues | null }[]; settingsNow: StopValues | null };
    expect(document).toMatchObject({ running: true, generations: [{ role: 'serving', version: '1.2.4', pid: 4002, lastStop: STOP_VALUES }], settingsNow: DEFAULT_STOP_VALUES });
  });
});
