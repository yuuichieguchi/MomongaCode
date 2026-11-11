import fs from 'node:fs';
import { fixedSocket, generationLayout } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { createSupervisorClient } from '../src/client/supervisor-client.ts';
import { DaemonStartError, ensureCurrentDaemon, ensureSessionDaemon, probeSupervisor, restartGeneration, restoreDaemon } from '../src/daemon/ensure-daemon.ts';
import { endSessionWhenMovedAway, sessionSocketResolver } from '../src/daemon/generations.ts';
import { recordingSpawn } from './fake-supervisor.ts';
import { SELF, setupGenerations } from './generations-harness.ts';

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

describe('a client older than the installed program, with no daemon serving (16.8, 20.68, 20.69, T-I6-1)', () => {
  const allocated = (paths: { run: string }): string[] => fs.readdirSync(paths.run).filter((entry) => /^g\d+$/.test(entry) || entry === 'generation.counter');

  it('asks the installed program for its version with the launch that reports it', async (context) => {
    const { paths, ports, asked } = await setupGenerations(context, '1.2.3', '1.2.4');

    await failureOf(ensureCurrentDaemon(ports, paths, { bounds: BOUNDS }));

    expect(asked).toEqual([{ file: SELF.execPath, args: ['/opt/momonga/main.js', '--version'] }]);
  });

  it('a one-shot command starts nothing with its own executable and prints the run-it-again line', async (context) => {
    const { paths, ports, spawned } = await setupGenerations(context, '1.2.3', '1.2.4');

    const failure = await failureOf(ensureCurrentDaemon(ports, paths, { bounds: BOUNDS }));

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(OLDER_COMMAND);
    expect(spawned).toEqual([]);
    expect(allocated(paths)).toEqual([]);
  });

  it('a restart asked of an older client starts nothing either', async (context) => {
    const { paths, start, ports, spawned } = await setupGenerations(context, '1.2.3', '1.2.4');
    const serving = await start({ version: '1.2.3' });

    const failure = await failureOf(restartGeneration(ports, paths, { bounds: BOUNDS }));

    expect((failure as Error).message).toBe(OLDER_COMMAND);
    expect(spawned).toEqual([]);
    expect(serving.shutdowns).toBe(0);
  });

  it('a session client moves to the installed program: the handover is given its version and nothing is spawned', async (context) => {
    const { paths, ports, spawned } = await setupGenerations(context, '1.2.3', '1.2.4');
    const moved: string[] = [];

    const failure = await failureOf(ensureSessionDaemon(ports, paths, { bounds: BOUNDS, onNewer: async (version) => void moved.push(version) }));

    expect(moved).toEqual(['1.2.4']);
    expect(spawned).toEqual([]);
    expect(allocated(paths)).toEqual([]);
    expect((failure as Error).message).toBe(REOPEN);
  });

  it('a session client without a handover is told to reopen, and a restored connection follows the same rule', async (context) => {
    const { paths, ports, spawned } = await setupGenerations(context, '1.2.3', '1.2.4');
    const moved: string[] = [];

    expect(((await failureOf(ensureSessionDaemon(ports, paths, { bounds: BOUNDS }))) as Error).message).toBe(REOPEN);
    expect(((await failureOf(restoreDaemon(ports, paths, async (version) => void moved.push(version))(undefined))) as Error).message).toBe(REOPEN);
    expect(moved).toEqual(['1.2.4']);
    expect(spawned).toEqual([]);
  });

  it('a client of the installed version starts the daemon with its own executable', async (context) => {
    const { paths, ports, spawned } = await setupGenerations(context, '1.2.3', '1.2.3');

    await failureOf(ensureCurrentDaemon(ports, paths, { bounds: BOUNDS }));

    expect(spawned.map((spec) => spec.command)).toEqual([SELF.execPath]);
  });

  it('a client newer than the installed program starts nothing and names both versions', async (context) => {
    const { paths, ports, spawned } = await setupGenerations(context, '1.2.3', '1.2.2');

    const failure = await failureOf(ensureCurrentDaemon(ports, paths, { bounds: BOUNDS }));

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe('The installed momonga is v1.2.2 and this command runs v1.2.3; run the command again.');
    expect(spawned).toEqual([]);
    expect(allocated(paths)).toEqual([]);
  });

  it('an installed program that does not report a version starts nothing and is named with its output', async (context) => {
    const { paths, ports, spawned } = await setupGenerations(context, '1.2.3', '1.2.3');
    const broken = { ...ports, exec: async () => ({ exitCode: 9, stdout: '', stderr: 'cannot execute\n' }) };
    const silent = {
      ...ports,
      timers: { setTimeout: (expire: () => void) => void expire(), clearTimeout: () => undefined },
      exec: (_file: string, _args: readonly string[], options: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener('abort', () => reject(options.signal.reason));
        }),
    };

    const failure = await failureOf(ensureCurrentDaemon(broken, paths, { bounds: BOUNDS }));

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(`The installed momonga (${SELF.execPath}) did not report its version (exit code 9: cannot execute). Check that momonga is still installed, then run the command again.`);
    expect(((await failureOf(ensureCurrentDaemon(silent, paths, { bounds: BOUNDS }))) as Error).message).toBe(
      `The installed momonga (${SELF.execPath}) did not report its version (no answer within 30 s). Check that momonga is still installed, then run the command again.`,
    );
    expect(spawned).toEqual([]);
  });

  it('a start abandoned because the program was replaced after the check prints the older-program text, never the new daemon of its own version (20.30)', async (context) => {
    const answers = ['1.2.3', '1.2.4'];
    const { paths, ports } = await setupGenerations(context, '1.2.3', () => answers.shift() ?? '1.2.4');
    const abandoning = recordingSpawn(async () => ({ code: 0, signal: null }));

    const failure = await failureOf(ensureCurrentDaemon({ ...ports, spawnDetached: abandoning.spawn }, paths, { bounds: BOUNDS }));

    expect(abandoning.spawned).toHaveLength(1);
    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe('momonga v1.2.3 is older than the last daemon version v1.2.4; update this program, then run it again.');
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
