import { describe, expect, it } from 'vitest';
import { stopAllGenerations } from '../src/daemon/generations.ts';
import type { CliClock } from '../src/ports.ts';
import { setupGenerations } from './generations-harness.ts';

type Signalled = { pid: number; signal: string; group: boolean };

const jumpingClock = (): CliClock => {
  let now = 0;
  return {
    now: () => now,
    sleep: async () => {
      now += 1_000_000;
    },
  };
};

const processes = (alive: Set<number>, dieOn: (sent: Signalled) => boolean) => {
  const signalled: Signalled[] = [];
  return {
    signalled,
    effects: {
      isAlive: (pid: number): boolean => alive.has(pid),
      signal: (pid: number, signal: NodeJS.Signals, group: boolean): void => {
        const sent = { pid, signal, group };
        signalled.push(sent);
        if (dieOn(sent)) alive.delete(pid);
      },
    },
  };
};

describe('stopAllGenerations, the teardown of a private home (20.78)', () => {
  it('signals the supervisor of every live generation and returns when all are gone', async (context) => {
    const { paths, start } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.3', generation: 1 });
    await start({ version: '1.2.4', generation: 2 });
    const { signalled, effects } = processes(new Set([process.pid]), () => true);

    await stopAllGenerations({ clock: jumpingClock(), ...effects }, paths);

    expect(signalled).toEqual([
      { pid: process.pid, signal: 'SIGTERM', group: false },
      { pid: process.pid, signal: 'SIGTERM', group: false },
    ]);
  });

  it('kills the group of a supervisor that outlasts the stop wait, and fails when it survives that', async (context) => {
    const { paths, start } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 1 });
    const killed = processes(new Set([process.pid]), (sent) => sent.signal === 'SIGKILL' && !sent.group);

    await stopAllGenerations({ clock: jumpingClock(), ...killed.effects }, paths);

    expect(killed.signalled.map((sent) => `${sent.signal}${sent.group ? ' group' : ''}`)).toEqual(['SIGTERM', 'SIGKILL group', 'SIGKILL']);

    const immortal = processes(new Set([process.pid]), () => false);
    await expect(stopAllGenerations({ clock: jumpingClock(), ...immortal.effects }, paths)).rejects.toThrow(`the daemon with pid ${process.pid} did not stop after SIGTERM and SIGKILL`);
  });

  it('does nothing in a home where no generation is live', async (context) => {
    const { paths } = await setupGenerations(context, '1.2.4');
    const { signalled, effects } = processes(new Set(), () => true);

    await stopAllGenerations({ clock: jumpingClock(), ...effects }, paths);

    expect(signalled).toEqual([]);
  });
});
