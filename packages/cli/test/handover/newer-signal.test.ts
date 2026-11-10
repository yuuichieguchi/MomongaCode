import { describe, expect, it } from 'vitest';
import { DaemonStartError, ensureDaemon, ensureSessionDaemon, restoreDaemon } from '../../src/daemon/ensure-daemon.ts';
import { endSessionWhenMovedAway } from '../../src/daemon/generations.ts';
import { setupGenerations } from '../generations-harness.ts';

const BOUNDS = { readyMs: 500, stopMs: 500 };
const REOPEN = 'momonga was updated to v1.2.4; reopen this session.';

const failureOf = async (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => undefined,
    (error: unknown) => error,
  );

const learner = () => {
  const learned: string[] = [];
  return { learned, onNewer: async (version: string) => void learned.push(version) };
};

describe('a session client learns that a newer generation is current (6.2, 16.8, red test 20)', () => {
  it('gets the health of the newer generation from ensureDaemon', async (context) => {
    const { paths, start, ports } = await setupGenerations(context, '1.2.3');
    await start({ version: '1.2.4' });
    expect(await ensureDaemon(ports, paths, { bounds: BOUNDS })).toMatchObject({ clientIsOlder: true, health: { version: '1.2.4' } });
  });

  it('is told the version while its own generation still serves it, and goes on', async (context) => {
    const { paths, start, ports } = await setupGenerations(context, '1.2.3');
    await start({ version: '1.2.3', generation: 1 });
    await start({ version: '1.2.4', generation: 2 });
    const { learned, onNewer } = learner();
    await expect(ensureSessionDaemon(ports, paths, { bounds: BOUNDS, onNewer })).resolves.toBeUndefined();
    await expect(restoreDaemon(ports, paths, onNewer)(undefined)).resolves.toBeUndefined();
    expect(learned).toEqual(['1.2.4', '1.2.4']);
  });

  it('is told the version before the reopen text when its own generation is gone and it stayed', async (context) => {
    const { paths, start, ports } = await setupGenerations(context, '1.2.3');
    await start({ version: '1.2.4' });
    const { learned, onNewer } = learner();
    const failure = await failureOf(ensureSessionDaemon(ports, paths, { bounds: BOUNDS, onNewer }));
    expect(learned).toEqual(['1.2.4']);
    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(REOPEN);
  });

  it('is not told anything by a daemon of its own version', async (context) => {
    const { paths, start, ports } = await setupGenerations(context, '1.2.3');
    await start({ version: '1.2.3' });
    const { learned, onNewer } = learner();
    await ensureSessionDaemon(ports, paths, { bounds: BOUNDS, onNewer });
    await endSessionWhenMovedAway(paths, '1.2.3', onNewer)();
    expect(learned).toEqual([]);
  });

  it('is told the version by a moved answer', async (context) => {
    const { paths, start } = await setupGenerations(context, '1.2.3');
    await start({ version: '1.2.4' });
    const { learned, onNewer } = learner();
    const failure = await failureOf(endSessionWhenMovedAway(paths, '1.2.3', onNewer)());
    expect(learned).toEqual(['1.2.4']);
    expect((failure as Error).message).toBe(REOPEN);
  });
});
