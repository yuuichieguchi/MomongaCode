import { describe, expect, it } from 'vitest';
import { daemonStatus } from '../src/commands/daemon.ts';
import type { CliPorts } from '../src/ports.ts';
import { setupGenerations } from './generations-harness.ts';

const STARTED = '2026-01-01T00:00:00.000Z';
const CHILD_LINES = '  gateway: ready (pid 101)\n  runtime: ready (pid 102)\n';

describe('momonga daemon status over the live generations (20.71)', () => {
  it('prints the serving generation as before, then one line per retiring and starting generation', async (context) => {
    const { paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.3', generation: 1, pid: 4001, reports: { steps: 2, jobs: 1, calls: 3 } });
    await start({ version: '1.2.4', generation: 2, pid: 4002 });
    await start({ version: '1.2.5', generation: 3, pid: 4003, publishes: false });

    const exitCode = await daemonStatus({ ...ports, interrupt: new AbortController().signal } as unknown as CliPorts, paths, { json: false });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join('')).toBe(
      `momonga daemon running: pid 4002, version 1.2.4, phase running, started ${STARTED}\n${CHILD_LINES}` +
        'v1.2.3 retiring (pid 4001): 2 steps in flight, 1 background jobs, 3 model calls in flight\n' +
        'v1.2.5 starting (pid 4003)\n',
    );
  });

  it('says not running first when only retiring generations live, and exits as for not running', async (context) => {
    const { paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.3', generation: 1, pid: 4001, reports: { steps: 1, jobs: 0, calls: 0 } });
    const ended = await start({ version: '1.2.4', generation: 2, pid: 4002 });
    await ended.stop();

    const exitCode = await daemonStatus({ ...ports, interrupt: new AbortController().signal } as unknown as CliPorts, paths, { json: false });

    expect(exitCode).toBe(1);
    expect(stdout.chunks.join('')).toBe('momonga daemon is not running\nv1.2.3 retiring (pid 4001): 1 steps in flight, 0 background jobs, 0 model calls in flight\n');
  });

  it('says not running and nothing else when no generation is live', async (context) => {
    const { paths, ports, stdout } = await setupGenerations(context, '1.2.4');

    expect(await daemonStatus({ ...ports, interrupt: new AbortController().signal } as unknown as CliPorts, paths, { json: false })).toBe(1);
    expect(stdout.chunks.join('')).toBe('momonga daemon is not running\n');
  });
});
