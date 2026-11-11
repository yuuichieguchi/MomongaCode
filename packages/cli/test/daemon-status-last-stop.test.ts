import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STOP_VALUES, generationLayout, writeStopRecord } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { daemonStatus } from '../src/commands/daemon.ts';
import type { CliPorts } from '../src/ports.ts';
import { setupGenerations } from './generations-harness.ts';
import { testKernelLock } from '@momonga/testkit';

const STARTED = '2026-01-01T00:00:00.000Z';
const CHILD_LINES = '  gateway: ready (pid 101)\n  runtime: ready (pid 102)\n';
const SERVING = `momonga daemon running: pid 4002, version 1.2.4, phase running, started ${STARTED}\n${CHILD_LINES}`;
const STOP_VALUES: StopValues = { closeGraceMs: 2000, managedServerStopGraceMs: 500, drainTimeoutMs: 7000, mcpCloseGraceMs: 0 };
const STOP_VALUES_TEXT = 'gateway.closeGraceMs 2000, gateway.managedServerStopGraceMs 500, runtime.drainTimeoutMs 7000, mcp.closeGraceMs 0';
const DEFAULTS_TEXT = `gateway.closeGraceMs ${DEFAULT_STOP_VALUES.closeGraceMs}, gateway.managedServerStopGraceMs ${DEFAULT_STOP_VALUES.managedServerStopGraceMs}, runtime.drainTimeoutMs ${DEFAULT_STOP_VALUES.drainTimeoutMs}, mcp.closeGraceMs ${DEFAULT_STOP_VALUES.mcpCloseGraceMs}`;

const writeUserSettings = (home: string, value: unknown): void => {
  fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify(value));
};

const settingsOf = (values: StopValues): unknown => ({
  gateway: { closeGraceMs: values.closeGraceMs, managedServerStopGraceMs: values.managedServerStopGraceMs },
  runtime: { drainTimeoutMs: values.drainTimeoutMs },
  mcp: { closeGraceMs: values.mcpCloseGraceMs },
});

describe('momonga daemon status shows the values of the last stop (close-grace design 3.5)', () => {
  it('shows nothing about a stop when the running daemon has no stop record', async (context) => {
    const { home, paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 2, pid: 4002 });
    writeUserSettings(home, settingsOf(STOP_VALUES));

    expect(await daemonStatus(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe(SERVING);
  });

  it('shows the values of the last stop alone when the settings file holds the same values', async (context) => {
    const { home, paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 2, pid: 4002 });
    await writeStopRecord(generationLayout(home, 2).stopRecord, 2, STOP_VALUES, testKernelLock());
    writeUserSettings(home, settingsOf(STOP_VALUES));

    expect(await daemonStatus(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe(`${SERVING}  last stop: ${STOP_VALUES_TEXT}\n`);
  });

  it('shows the current values of the settings file under the last stop when they differ', async (context) => {
    const { home, paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 2, pid: 4002 });
    await writeStopRecord(generationLayout(home, 2).stopRecord, 2, STOP_VALUES, testKernelLock());

    expect(await daemonStatus(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe(`${SERVING}  last stop: ${STOP_VALUES_TEXT}\n  settings now: ${DEFAULTS_TEXT}\n`);
  });

  it('shows the last stop of a retiring generation under its own line', async (context) => {
    const { home, paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.3', generation: 1, pid: 4001, reports: { steps: 1, jobs: 0, calls: 0 } });
    await start({ version: '1.2.4', generation: 2, pid: 4002 });
    await writeStopRecord(generationLayout(home, 1).stopRecord, 1, STOP_VALUES, testKernelLock());
    writeUserSettings(home, settingsOf(STOP_VALUES));

    expect(await daemonStatus(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe(
      `${SERVING}v1.2.3 retiring (pid 4001): 1 steps in flight, 0 background jobs, 0 model calls in flight\n  last stop: ${STOP_VALUES_TEXT}\n`,
    );
  });

  it('shows no stop for a record that names another generation', async (context) => {
    const { home, paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 2, pid: 4002 });
    await writeStopRecord(generationLayout(home, 2).stopRecord, 1, STOP_VALUES, testKernelLock());

    expect(await daemonStatus(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe(SERVING);
  });
});
