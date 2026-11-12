import { describe, expect, it } from 'vitest';
import { daemonStop, stoppingText } from '../src/commands/daemon.ts';
import { stopDaemon } from '../src/daemon/ensure-daemon.ts';
import { PollTimeout } from '../src/poll.ts';
import type { CliClock, CliPorts } from '../src/ports.ts';
import { setupGenerations } from './generations-harness.ts';
import { afterMicrotasks } from '@momonga/testkit';

const STOPPING = 'Stopping the daemon. This interrupts 2 running steps and 1 background jobs: run r1, run r2, job j1 (sleep 100). Interrupted runs resume when the daemon starts again.\n';

const oversleepingClock = (): CliClock => {
  let now = 0;
  return {
    now: () => now,
    sleep: async () => {
      now = Number.MAX_SAFE_INTEGER;
      await afterMicrotasks();
    },
  };
};

describe('the text of what a stop interrupts (20.75)', () => {
  it('lists up to five items and counts the rest', () => {
    expect(stoppingText({ steps: 2, jobs: 1, items: [{ kind: 'run', id: 'r1' }, { kind: 'run', id: 'r2' }, { kind: 'job', id: 'j1', command: 'sleep 100' }] })).toBe(
      'Stopping the daemon. This interrupts 2 running steps and 1 background jobs: run r1, run r2, job j1 (sleep 100). Interrupted runs resume when the daemon starts again.',
    );
    expect(stoppingText({ steps: 7, jobs: 0, items: ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ kind: 'run' as const, id })) })).toBe(
      'Stopping the daemon. This interrupts 7 running steps and 0 background jobs: run r1, run r2, run r3, run r4, run r5 and 2 more. Interrupted runs resume when the daemon starts again.',
    );
  });
});

describe('momonga daemon stop over the live generations (20.75, 15.14 P7 d)', () => {
  it('prints what it interrupts first, stops every live generation and then says stopped', async (context) => {
    const { paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    const retiring = await start({ version: '1.2.3', generation: 1, reports: { steps: 2, jobs: 1, calls: 0, interrupts: [{ kind: 'run', id: 'r1' }, { kind: 'run', id: 'r2' }, { kind: 'job', id: 'j1', command: 'sleep 100' }] } });
    const serving = await start({ version: '1.2.4', generation: 2, reports: { steps: 0, jobs: 0, calls: 0 } });

    const exitCode = await daemonStop(ports as unknown as CliPorts, paths);

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join('')).toBe(`${STOPPING}momonga daemon stopped\n`);
    expect(retiring.shutdowns).toBe(1);
    expect(serving.shutdowns).toBe(1);
  });

  it('names the one running step it interrupts', async (context) => {
    const { paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 1, reports: { steps: 1, jobs: 0, calls: 0, interrupts: [{ kind: 'run', id: 'run-a' }] } });

    expect(await daemonStop(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe(
      'Stopping the daemon. This interrupts 1 running steps and 0 background jobs: run run-a. Interrupted runs resume when the daemon starts again.\nmomonga daemon stopped\n',
    );
  });

  it('names five of the seven steps and jobs of two generations and counts the other two', async (context) => {
    const { paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({
      version: '1.2.3',
      generation: 1,
      reports: { steps: 2, jobs: 2, calls: 0, interrupts: [{ kind: 'run', id: 'r1' }, { kind: 'run', id: 'r2' }, { kind: 'job', id: 'j1', command: 'sleep 100' }, { kind: 'job', id: 'j2', command: 'make' }] },
    });
    await start({
      version: '1.2.4',
      generation: 2,
      reports: { steps: 2, jobs: 1, calls: 0, interrupts: [{ kind: 'run', id: 'r3' }, { kind: 'run', id: 'r4' }, { kind: 'job', id: 'j3', command: 'npm test' }] },
    });

    expect(await daemonStop(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe(
      'Stopping the daemon. This interrupts 4 running steps and 3 background jobs: run r1, run r2, job j1 (sleep 100), job j2 (make), run r3 and 2 more. Interrupted runs resume when the daemon starts again.\nmomonga daemon stopped\n',
    );
  });

  it('prints nothing before the stop when nothing is interrupted', async (context) => {
    const { paths, start, ports, stdout } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 1, reports: { steps: 0, jobs: 0, calls: 2 } });

    expect(await daemonStop(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe('momonga daemon stopped\n');
  });

  it('says not running when nothing is live', async (context) => {
    const { paths, ports, stdout } = await setupGenerations(context, '1.2.4');

    expect(await daemonStop(ports as unknown as CliPorts, paths)).toBe(0);
    expect(stdout.chunks.join('')).toBe('momonga daemon is not running\n');
  });

  it('waits once, for the largest bound the generations report, until every lock is free, and names each generation that outlasts it', async (context) => {
    const { paths, start, ports } = await setupGenerations(context, '1.2.4');
    const first = await start({ version: '1.2.3', generation: 1, pid: 4001, phase: 'draining', stopBoundMs: 90_000, publishes: false });
    await start({ version: '1.2.4', generation: 2, pid: 4002, phase: 'draining', stopBoundMs: 200_000, publishes: false });

    const both = await stopDaemon({ ...ports, clock: oversleepingClock() }, paths).catch((error: unknown) => error);

    expect(both).toBeInstanceOf(PollTimeout);
    expect((both as PollTimeout).boundMs).toBe(200_000);
    expect((both as PollTimeout).description).toBe('the daemon to stop');
    expect((both as PollTimeout).message).toBe('the daemon (v1.2.3, pid 4001) did not stop within 200000 ms; the daemon (v1.2.4, pid 4002) did not stop within 200000 ms');

    await first.stop();
    const one = await stopDaemon({ ...ports, clock: oversleepingClock() }, paths).catch((error: unknown) => error);

    expect((one as PollTimeout).message).toBe('the daemon (v1.2.4, pid 4002) did not stop within 200000 ms');
  });
});
