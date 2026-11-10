import { fixedSocket, generationLayout } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { createSupervisorClient } from '../src/client/supervisor-client.ts';
import { DaemonStartError, ensureCurrentDaemon, ensureSessionDaemon, probeSupervisor, restoreDaemon } from '../src/daemon/ensure-daemon.ts';
import { endSessionWhenMovedAway, sessionSocketResolver } from '../src/daemon/generations.ts';
import { setupGenerations } from './generations-harness.ts';

const BOUNDS = { readyMs: 500, stopMs: 500 };
const OLDER_COMMAND = 'momonga was updated to v1.2.4 while this command was running; run it again. Your tasks are not affected.';
const REOPEN = 'momonga was updated to v1.2.4; reopen this session.';

const failureOf = async (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('a one-shot command older than the daemon (20.68)', () => {
  it('fails with the run-it-again line, starts nothing and stops nothing', async (context) => {
    const { paths, start, ports, spawned } = await setupGenerations(context, '1.2.3');
    const serving = await start({ version: '1.2.4' });

    const failure = await failureOf(ensureCurrentDaemon(ports, paths, { bounds: BOUNDS }));

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(OLDER_COMMAND);
    expect(spawned).toEqual([]);
    expect(serving.shutdowns).toBe(0);
  });

  it('returns the health of a daemon of its own version', async (context) => {
    const { paths, start, ports } = await setupGenerations(context, '1.2.3');
    await start({ version: '1.2.3' });

    expect(await ensureCurrentDaemon(ports, paths, { bounds: BOUNDS })).toMatchObject({ version: '1.2.3', phase: 'running' });
  });
});

describe('a session client older than the daemon, before the handover exists (20.69)', () => {
  it('is told to reopen when no live generation runs its version', async (context) => {
    const { paths, start, ports, spawned } = await setupGenerations(context, '1.2.3');
    const serving = await start({ version: '1.2.4' });

    const failure = await failureOf(ensureSessionDaemon(ports, paths, { bounds: BOUNDS }));

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(REOPEN);
    expect(spawned).toEqual([]);
    expect(serving.shutdowns).toBe(0);
  });

  it('keeps working while a live generation of its version exists, and dials that generation', async (context) => {
    const { home, paths, start, ports } = await setupGenerations(context, '1.2.3');
    const own = await start({ version: '1.2.3', generation: 1 });
    await start({ version: '1.2.4', generation: 2 });

    await expect(ensureSessionDaemon(ports, paths, { bounds: BOUNDS })).resolves.toBeUndefined();
    await expect(restoreDaemon(ports, paths)(undefined)).resolves.toBeUndefined();
    expect(await sessionSocketResolver(paths, '1.2.3', 'runtime')()).toBe(generationLayout(home, 1).sockets.runtime);
    expect(await sessionSocketResolver(paths, '1.2.4', 'runtime')()).toBe(generationLayout(home, 2).sockets.runtime);
    expect(own.shutdowns).toBe(0);
  });

  it('finds no socket once its generation is gone, as an unreachable daemon', async (context) => {
    const { paths, start } = await setupGenerations(context, '1.2.3');
    await start({ version: '1.2.4' });

    expect(await failureOf(sessionSocketResolver(paths, '1.2.3', 'runtime')())).toMatchObject({ code: 'ENOENT' });
  });

  it('ends on a moved answer when the serving generation runs another version, and resends when it runs its own', async (context) => {
    const { paths, start } = await setupGenerations(context, '1.2.3');
    await start({ version: '1.2.3', generation: 1 });
    await expect(endSessionWhenMovedAway(paths, '1.2.3')()).resolves.toBeUndefined();
    await start({ version: '1.2.4', generation: 2 });

    const failure = await failureOf(endSessionWhenMovedAway(paths, '1.2.3')());

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(REOPEN);
  });
});

describe('a dial to a generation that was removed (T-L2-9)', () => {
  it('answers undefined for the removed generation while every dial to the live one succeeds', async (context) => {
    const { home, start } = await setupGenerations(context, '1.2.3');
    const removed = await start({ version: '1.2.3', generation: 1 });
    await start({ version: '1.2.4', generation: 2 });
    await removed.stop();
    const gone = createSupervisorClient({ resolveSocket: fixedSocket(generationLayout(home, 1).sockets.supervisor) });
    const live = createSupervisorClient({ resolveSocket: fixedSocket(generationLayout(home, 2).sockets.supervisor) });
    try {
      expect(await probeSupervisor(gone)).toBeUndefined();
      for (let dial = 0; dial < 100; dial += 1) expect((await probeSupervisor(live))?.version).toBe('1.2.4');
    } finally {
      await gone.close();
      await live.close();
    }
  });
});
