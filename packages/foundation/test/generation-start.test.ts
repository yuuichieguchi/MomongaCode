import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import * as foundation from '@momonga/foundation';
import { SocketPathUnsupportedError, ensureMomongaDirs, generationLayout, momongaPaths, publishCurrentGeneration, setSocketBind } from '@momonga/foundation';
import type { FakeKernelLock } from '@momonga/testkit';
import { createFakeKernelLock, registerCleanup, withTempDir } from '@momonga/testkit';

const FOLD_VERSION = 1;

type StartRecord = { version: string; foldVersion: number };
type StartedOutcome =
  | { kind: 'allocated'; generation: number }
  | { kind: 'joined'; generation: number }
  | { kind: 'serving'; generation: number; version: string }
  | { kind: 'below-floor'; floor: string };
type StartView = {
  clientVersion: string;
  current?: { generation: number; version: string };
  serving: boolean;
  starting: readonly { generation: number; version: string }[];
};
type StartDecision = { kind: 'connect'; generation: number } | { kind: 'older'; version: string } | { kind: 'below-floor'; floor: string } | { kind: 'join'; generation: number } | { kind: 'allocate' };
type StarterView = { own: { generation: number; version: string }; current?: { generation: number; version: string }; currentHeld: boolean; currentDraining: boolean; ownSupervisorGone: boolean };

type I3 = {
  beginGenerationStart(paths: foundation.MomongaPaths, options: { version: string; foldVersion: number; lock: foundation.KernelLockMechanism }): Promise<StartedOutcome>;
  decideGenerationStart(view: StartView): StartDecision;
  claimGeneration(paths: foundation.MomongaPaths, generation: number, options: { version: string; lock: foundation.KernelLockMechanism }): Promise<{ kind: 'claimed' } | { kind: 'abandoned' }>;
  generationIsLive(paths: foundation.MomongaPaths, generation: number, options: { lock: foundation.KernelLockMechanism }): Promise<boolean>;
  starterOutcome(view: StarterView): 'success' | 'waiting' | 'failed';
  GenerationCounterError: new (...args: never[]) => Error;
};

const i3 = foundation as unknown as I3;

type Layout = foundation.GenerationLayout & { startRecord: string; startingLock: string; markers: string };
type Paths = foundation.MomongaPaths & { generationCounter: string };

const layoutOf = (home: string, generation: number): Layout => generationLayout(home, generation) as Layout;

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home) as Paths;
  await ensureMomongaDirs(paths);
  const lock: FakeKernelLock = createFakeKernelLock({ inheritable: false });
  return { home, paths, lock };
};

const counterOf = (paths: Paths): number => Number(fs.readFileSync(paths.generationCounter, 'utf8').trim());

const writeCounter = (paths: Paths, text: string): void => fs.writeFileSync(paths.generationCounter, text);

const generationDirs = (paths: Paths): string[] => fs.readdirSync(paths.run).filter((entry) => /^g\d+$/.test(entry)).sort();

const makeStartingGeneration = (home: string, generation: number, version: string): Layout => {
  const layout = layoutOf(home, generation);
  fs.mkdirSync(layout.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(layout.startRecord, JSON.stringify({ version, foldVersion: FOLD_VERSION }));
  return layout;
};

const publish = async (home: string, paths: Paths, generation: number, version: string): Promise<void> => {
  await publishCurrentGeneration(paths, { generation, version, sockets: generationLayout(home, generation).sockets });
};

describe('the generation layout of the start flow (15.1, 15.2, 15.8)', () => {
  it('keeps the counter at run/generation.counter beside run/generation.lock', (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home) as Paths;
    expect(paths.generationCounter).toBe(path.join(home, '.momonga', 'run', 'generation.counter'));
  });

  it('keeps start.json and starting.lock inside run/g<N>/, and the markers in markers/g<N>/', (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    const layout = layoutOf(home, 7);
    expect(layout.startRecord).toBe(path.join(home, '.momonga', 'run', 'g7', 'start.json'));
    expect(layout.startingLock).toBe(path.join(home, '.momonga', 'run', 'g7', 'starting.lock'));
    expect(layout.markers).toBe(path.join(paths.markers.root, 'g7'));
  });
});

describe('numbering under run/generation.lock (15.1)', () => {
  it('takes 1 when the counter is missing, records 1, and creates only run/g1', async (context) => {
    const { paths, lock } = await setup(context);
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'allocated', generation: 1 });
    expect(counterOf(paths)).toBe(1);
    expect(generationDirs(paths)).toEqual(['g1']);
  });

  it('takes the number after the counter, never a number from the listing, when every directory was reaped', async (context) => {
    const { paths, lock } = await setup(context);
    writeCounter(paths, '3');
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'allocated', generation: 4 });
    expect(counterOf(paths)).toBe(4);
    expect(generationDirs(paths)).toEqual(['g4']);
  });

  it('never reuses a number consumed by a starter that died after the counter write and before the directory', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    makeStartingGeneration(home, 1, '1.2.3');
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.4', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'allocated', generation: 3 });
    expect(counterOf(paths)).toBe(3);
    expect(fs.existsSync(layoutOf(home, 2).dir)).toBe(false);
  });

  it.for([
    ['a counter that is a directory', (paths: Paths) => fs.mkdirSync(paths.generationCounter)],
    ['a counter that is not decimal text', (paths: Paths) => writeCounter(paths, 'three')],
    ['a counter that is not a positive whole number', (paths: Paths) => writeCounter(paths, '-1')],
  ] as const)('refuses the start on %s, guesses no number and writes nothing', async ([, spoil], context) => {
    const { paths, lock } = await setup(context);
    spoil(paths);
    const failure = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(i3.GenerationCounterError);
    expect(generationDirs(paths)).toEqual([]);
  });

  it('refuses a number whose sockets do not fit with SocketPathUnsupportedError, and consumes no number', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '9');
    const fitting = Buffer.byteLength(layoutOf(home, 9).sockets.supervisor);
    setSocketBind(async (socketPath) => {
      if (Buffer.byteLength(socketPath) > fitting) throw Object.assign(new Error('name too long'), { code: 'EINVAL' });
    });
    registerCleanup(context, () => setSocketBind(undefined));
    const failure = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SocketPathUnsupportedError);
    expect(fs.readFileSync(paths.generationCounter, 'utf8')).toBe('9');
    expect(generationDirs(paths)).toEqual([]);
  });
});

describe('the start record and the starting lock (15.2, 15.3 S1)', () => {
  it('writes start.json with the version of the start and the fold version', async (context) => {
    const { home, paths, lock } = await setup(context);
    await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    const record = JSON.parse(fs.readFileSync(layoutOf(home, 1).startRecord, 'utf8')) as StartRecord;
    expect(record).toEqual({ version: '1.2.3', foldVersion: FOLD_VERSION });
  });

  it('holds starting.lock past the return and releases run/generation.lock before it returns', async (context) => {
    const { home, paths, lock } = await setup(context);
    await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    expect(lock.claimsMade()).toContain(paths.generationLock);
    expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
    expect(lock.isHeldBy(layoutOf(home, 1).startingLock)).toBe('claim');
  });

  it('lets a second start request of the same version join the starting generation, with no counter write and no new directory', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    const starting = makeStartingGeneration(home, 2, '1.2.3');
    lock.holdExternally(starting.startingLock, 4242);
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'joined', generation: 2 });
    expect(fs.readFileSync(paths.generationCounter, 'utf8')).toBe('2');
    expect(generationDirs(paths)).toEqual(['g2']);
  });

  it('joins a starting generation whose supervisor has already claimed its lock', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    const starting = makeStartingGeneration(home, 2, '1.2.4');
    lock.holdExternally(starting.locks.supervisor, 4243);
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'joined', generation: 2 });
  });

  it('allocates above a starting generation older than the request', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    const starting = makeStartingGeneration(home, 2, '1.2.3');
    lock.holdExternally(starting.startingLock, 4242);
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.4', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'allocated', generation: 3 });
  });

  it('does not join a directory whose starter and supervisor are both gone', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    makeStartingGeneration(home, 2, '1.2.3');
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'allocated', generation: 3 });
  });

  it('does not join a generation numbered below run/current, which is superseded', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '3');
    const superseded = makeStartingGeneration(home, 2, '1.2.3');
    lock.holdExternally(superseded.startingLock, 4242);
    await publish(home, paths, 3, '1.2.2');
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'allocated', generation: 4 });
  });
});

describe('the decision against a live run/current, read from disk (15.4)', () => {
  it('starts nothing when the serving generation runs the client version', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '1');
    makeStartingGeneration(home, 1, '1.2.3');
    lock.holdExternally(layoutOf(home, 1).locks.supervisor, 4100);
    await publish(home, paths, 1, '1.2.3');
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.3', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'serving', generation: 1, version: '1.2.3' });
    expect(counterOf(paths)).toBe(1);
  });

  it('allocates a newer generation beside an older serving one, and leaves the serving one in place', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '1');
    makeStartingGeneration(home, 1, '1.2.3');
    lock.holdExternally(layoutOf(home, 1).locks.supervisor, 4100);
    await publish(home, paths, 1, '1.2.3');
    const outcome = await i3.beginGenerationStart(paths, { version: '1.2.4', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'allocated', generation: 2 });
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toMatchObject({ generation: 1, version: '1.2.3' });
    expect(lock.isHeldBy(layoutOf(home, 1).locks.supervisor)).toBe('external');
  });

  it('refuses a client below the floor recorded in run/current when no generation serves, and allocates nothing', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '1');
    await publish(home, paths, 1, '2.0.0');
    const outcome = await i3.beginGenerationStart(paths, { version: '1.9.0', foldVersion: FOLD_VERSION, lock });
    expect(outcome).toEqual({ kind: 'below-floor', floor: '2.0.0' });
    expect(counterOf(paths)).toBe(1);
    expect(generationDirs(paths)).toEqual([]);
  });
});

describe('the decision table (15.4)', () => {
  const current = { generation: 3, version: '1.2.3' };

  it('connects when the serving generation runs the client version (rule 1)', () => {
    expect(i3.decideGenerationStart({ clientVersion: '1.2.3', current, serving: true, starting: [] })).toEqual({ kind: 'connect', generation: 3 });
  });

  it('starts and stops nothing for a client older than the serving generation (rule 2)', () => {
    expect(i3.decideGenerationStart({ clientVersion: '1.2.2', current, serving: true, starting: [{ generation: 4, version: '1.2.2' }] })).toEqual({ kind: 'older', version: '1.2.3' });
  });

  it.for([
    ['dead', { current, serving: false }],
    ['draining', { current, serving: false }],
  ] as const)('refuses below the floor when the generation of run/current is %s (rule 3)', ([, view]) => {
    expect(i3.decideGenerationStart({ clientVersion: '1.2.2', starting: [], ...view })).toEqual({ kind: 'below-floor', floor: '1.2.3' });
  });

  it('takes the floor as 0 when there is no run/current', () => {
    expect(i3.decideGenerationStart({ clientVersion: '0.0.1', serving: false, starting: [] })).toEqual({ kind: 'allocate' });
  });

  it('joins a starting generation of at least the client version (rule 4)', () => {
    expect(i3.decideGenerationStart({ clientVersion: '1.2.4', current, serving: true, starting: [{ generation: 5, version: '1.2.5' }] })).toEqual({ kind: 'join', generation: 5 });
  });

  it('allocates when the only starting generation is older than the client (rule 5)', () => {
    expect(i3.decideGenerationStart({ clientVersion: '1.2.5', current, serving: true, starting: [{ generation: 5, version: '1.2.4' }] })).toEqual({ kind: 'allocate' });
  });

  it('allocates for a newer client beside a serving older generation, and decides no stop (rule 5, rule 1)', () => {
    expect(i3.decideGenerationStart({ clientVersion: '1.2.4', current, serving: true, starting: [] })).toEqual({ kind: 'allocate' });
  });
});

describe('the supervisor claim (15.3 S2)', () => {
  it('claims supervisor.lock when g<N>/ and start.json name the version of the executable', async (context) => {
    const { home, paths, lock } = await setup(context);
    const layout = makeStartingGeneration(home, 2, '1.2.3');
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'claimed' });
    expect(lock.isHeldBy(layout.locks.supervisor)).toBe('claim');
    expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
  });

  it('exits as an abandoned start when g<N>/ was reaped', async (context) => {
    const { home, paths, lock } = await setup(context);
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'abandoned' });
    expect(fs.existsSync(layoutOf(home, 2).dir)).toBe(false);
    expect(lock.claimsMade()).not.toContain(layoutOf(home, 2).locks.supervisor);
  });

  it('exits as an abandoned start when start.json is missing', async (context) => {
    const { home, paths, lock } = await setup(context);
    fs.mkdirSync(layoutOf(home, 2).dir, { recursive: true });
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'abandoned' });
    expect(lock.isHeldBy(layoutOf(home, 2).locks.supervisor)).toBeUndefined();
  });

  it('exits as an abandoned start when start.json names another version', async (context) => {
    const { home, paths, lock } = await setup(context);
    makeStartingGeneration(home, 2, '1.2.4');
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'abandoned' });
    expect(lock.isHeldBy(layoutOf(home, 2).locks.supervisor)).toBeUndefined();
  });

  it('exits as an abandoned start when a reaper holds supervisor.lock', async (context) => {
    const { home, paths, lock } = await setup(context);
    const layout = makeStartingGeneration(home, 2, '1.2.3');
    lock.holdExternally(layout.locks.supervisor, 4300);
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'abandoned' });
    expect(lock.isHeldBy(layout.locks.supervisor)).toBe('external');
  });
});

describe('a generation is live while its supervisor lock or its starting lock is held (15.2, 15.8, 17.5)', () => {
  it.for([
    ['both free', false, false, false],
    ['the supervisor lock held', true, false, true],
    ['the starting lock held', false, true, true],
    ['both held', true, true, true],
  ] as const)('with %s', async ([, supervisorHeld, startingHeld, live], context) => {
    const { home, paths, lock } = await setup(context);
    const layout = makeStartingGeneration(home, 2, '1.2.3');
    if (supervisorHeld) lock.holdExternally(layout.locks.supervisor, 4400);
    if (startingHeld) lock.holdExternally(layout.startingLock, 4401);
    expect(await i3.generationIsLive(paths, 2, { lock })).toBe(live);
  });
});

describe("the starter's outcome (15.3 S5)", () => {
  const own = { generation: 2, version: '1.2.3' };

  it('succeeds when run/current names its own generation, held and not draining', () => {
    expect(i3.starterOutcome({ own, current: { generation: 2, version: '1.2.3' }, currentHeld: true, currentDraining: false, ownSupervisorGone: false })).toBe('success');
  });

  it('succeeds through a later generation of at least its version', () => {
    expect(i3.starterOutcome({ own, current: { generation: 3, version: '1.2.4' }, currentHeld: true, currentDraining: false, ownSupervisorGone: true })).toBe('success');
  });

  it('does not succeed on a current generation whose supervisor lock is free', () => {
    expect(i3.starterOutcome({ own, current: { generation: 2, version: '1.2.3' }, currentHeld: false, currentDraining: false, ownSupervisorGone: false })).toBe('waiting');
  });

  it('does not succeed on a current generation that is draining', () => {
    expect(i3.starterOutcome({ own, current: { generation: 2, version: '1.2.3' }, currentHeld: true, currentDraining: true, ownSupervisorGone: false })).toBe('waiting');
  });

  it('does not succeed through a later generation of a lower version', () => {
    expect(i3.starterOutcome({ own, current: { generation: 3, version: '1.2.2' }, currentHeld: true, currentDraining: false, ownSupervisorGone: false })).toBe('waiting');
  });

  it('does not succeed on an earlier generation', () => {
    expect(i3.starterOutcome({ own, current: { generation: 1, version: '1.2.3' }, currentHeld: true, currentDraining: false, ownSupervisorGone: false })).toBe('waiting');
  });

  it('fails when its own supervisor is gone without a promotion that covers it', () => {
    expect(i3.starterOutcome({ own, current: { generation: 1, version: '1.2.2' }, currentHeld: true, currentDraining: false, ownSupervisorGone: true })).toBe('failed');
  });
});

describe('promotion is monotone in the number (15.5)', () => {
  it.for([
    ['a lower number', 2],
    ['the same number', 3],
  ] as const)('leaves run/current byte for byte when the publish carries %s', async ([, generation], context) => {
    const { home, paths } = await setup(context);
    await publish(home, paths, 3, '1.2.3');
    const before = fs.readFileSync(paths.current, 'utf8');
    const inode = fs.statSync(paths.current).ino;
    await publish(home, paths, generation, '1.2.4');
    expect(fs.readFileSync(paths.current, 'utf8')).toBe(before);
    expect(fs.statSync(paths.current).ino).toBe(inode);
  });

  it('replaces run/current when the number is above the current one', async (context) => {
    const { home, paths } = await setup(context);
    await publish(home, paths, 3, '1.2.3');
    await publish(home, paths, 4, '1.2.4');
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toEqual({ generation: 4, version: '1.2.4', sockets: generationLayout(home, 4).sockets });
  });
});
