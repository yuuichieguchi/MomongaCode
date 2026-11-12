import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import {
  GenerationCounterError,
  GenerationDirectoryMissingError,
  GenerationPrepareError,
  SocketPathUnsupportedError,
  beginGenerationStart,
  claimGeneration,
  decideGenerationStart,
  ensureMomongaDirs,
  generationIsLive,
  generationLayout,
  momongaPaths,
  nodeGenerationStartFiles,
  publishCurrentGeneration,
  readGenerationRole,
  requireGenerationDirs,
  scopeToGeneration,
  setSocketBind,
  starterOutcome,
} from '@momonga/foundation';
import type { GenerationLayout, GenerationStartFiles, KernelLockMechanism, MomongaPaths, StartOutcome } from '@momonga/foundation';
import type { FakeKernelLock } from '@momonga/testkit';
import { createFakeKernelLock, prepareGenerationForTest, registerCleanup, withTempDir, testKernelLock } from '@momonga/testkit';

const UNIX_ENDPOINTS = { form: 'unix' } as const;

const FOLD_VERSION = 1;

type StartRecord = { version: string; foldVersion: number };
type Layout = GenerationLayout;
type Paths = MomongaPaths;

const i3 = { beginGenerationStart, decideGenerationStart, claimGeneration, generationIsLive, starterOutcome, GenerationCounterError };

const layoutOf = (home: string, generation: number): Layout => generationLayout(home, generation);

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
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

const publish = async (home: string, paths: Paths, generation: number, version: string): Promise<string> =>
  publishCurrentGeneration(paths, { generation, version, sockets: generationLayout(home, generation).sockets }, { lock: testKernelLock() });

const start = (paths: Paths, lock: KernelLockMechanism, version = '1.2.3', extra: Partial<Parameters<typeof beginGenerationStart>[1]> = {}): Promise<StartOutcome> =>
  beginGenerationStart(paths, { version, foldVersion: FOLD_VERSION, lock, scope: UNIX_ENDPOINTS, ...extra });

describe('the generation layout of the start flow (15.1, 15.2, 15.8)', () => {
  it('keeps the counter at run/generation.counter beside run/generation.lock', (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    expect(paths.generationCounter).toBe(path.join(home, '.momonga', 'run', 'generation.counter'));
  });

  it('keeps start.json and starting.lock inside run/g<N>/, and the markers in markers/g<N>/', (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    const layout = layoutOf(home, 7);
    expect(layout.startRecord).toBe(path.join(home, '.momonga', 'run', 'g7', 'start.json'));
    expect(layout.startingLock).toBe(path.join(home, '.momonga', 'run', 'g7', 'starting.lock'));
    expect(layout.markers).toBe(path.join(paths.markers.root, 'g7'));
  });
});

describe('numbering under run/generation.lock (15.1)', () => {
  it('takes 1 when the counter is missing, records 1, and creates only run/g1', async (context) => {
    const { paths, lock } = await setup(context);
    const outcome = await start(paths, lock);
    expect(outcome).toMatchObject({ kind: 'allocated', generation: 1 });
    expect(counterOf(paths)).toBe(1);
    expect(generationDirs(paths)).toEqual(['g1']);
  });

  it('takes the number after the counter, never a number from the listing, when every directory was reaped', async (context) => {
    const { paths, lock } = await setup(context);
    writeCounter(paths, '3');
    const outcome = await start(paths, lock);
    expect(outcome).toMatchObject({ kind: 'allocated', generation: 4 });
    expect(counterOf(paths)).toBe(4);
    expect(generationDirs(paths)).toEqual(['g4']);
  });

  it('never reuses a number consumed by a starter that died after the counter write and before the directory', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    makeStartingGeneration(home, 1, '1.2.3');
    const outcome = await start(paths, lock, '1.2.4');
    expect(outcome).toMatchObject({ kind: 'allocated', generation: 3 });
    expect(counterOf(paths)).toBe(3);
    expect(fs.existsSync(layoutOf(home, 2).dir)).toBe(false);
  });

  const NOT_REGULAR = 'it is not a regular file';
  const NOT_DECIMAL = 'it does not hold one decimal number';
  const TOO_LARGE = 'it is larger than a safe integer';

  it.for([
    ['a directory', (paths: Paths) => fs.mkdirSync(paths.generationCounter), NOT_REGULAR],
    ['a symbolic link to a regular file', (paths: Paths) => {
      fs.writeFileSync(`${paths.generationCounter}.target`, '7');
      fs.symlinkSync(`${paths.generationCounter}.target`, paths.generationCounter);
    }, NOT_REGULAR],
    ['the text three', (paths: Paths) => writeCounter(paths, 'three'), NOT_DECIMAL],
    ['-1', (paths: Paths) => writeCounter(paths, '-1'), NOT_DECIMAL],
    ['0', (paths: Paths) => writeCounter(paths, '0'), NOT_DECIMAL],
    ['1.5', (paths: Paths) => writeCounter(paths, '1.5'), NOT_DECIMAL],
    ['a leading zero', (paths: Paths) => writeCounter(paths, '007'), NOT_DECIMAL],
    ['an empty file', (paths: Paths) => writeCounter(paths, ''), NOT_DECIMAL],
    ['a CRLF ending', (paths: Paths) => writeCounter(paths, '7\r\n'), NOT_DECIMAL],
    ['a trailing space', (paths: Paths) => writeCounter(paths, '7 '), NOT_DECIMAL],
    ['9007199254740992', (paths: Paths) => writeCounter(paths, '9007199254740992'), TOO_LARGE],
    ['17 digits', (paths: Paths) => writeCounter(paths, '99999999999999999'), TOO_LARGE],
  ] as const)('refuses the start on a counter that is %s with the settled text, guesses no number and writes nothing', async ([, spoil, reason], context) => {
    const { paths, lock } = await setup(context);
    spoil(paths);
    const failure = await start(paths, lock).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GenerationCounterError);
    expect((failure as GenerationCounterError).code).toBe('generation_counter');
    expect((failure as Error).message).toBe(
      `momonga cannot read the generation counter at ${paths.generationCounter}: ${reason}. No generation was started, because a generation number is never guessed. Repair the file so that it holds one decimal number, then run the command again.`,
    );
    expect(generationDirs(paths)).toEqual([]);
    expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
  });

  it.for([['7'], ['7\n']] as const)('reads the counter %j as 7', async ([text], context) => {
    const { paths, lock } = await setup(context);
    writeCounter(paths, text);
    expect(await start(paths, lock)).toMatchObject({ kind: 'allocated', generation: 8 });
    expect(fs.readFileSync(paths.generationCounter, 'utf8')).toBe('8\n');
  });

  it('reads at most 17 bytes of the counter', async (context) => {
    const { paths, lock } = await setup(context);
    writeCounter(paths, '9'.repeat(1024 * 1024));
    const reads: number[] = [];
    const files: GenerationStartFiles = { ...nodeGenerationStartFiles, readHead: async (file, maxBytes) => {
      reads.push(maxBytes);
      return nodeGenerationStartFiles.readHead(file, maxBytes);
    } };
    const failure = await start(paths, lock, '1.2.3', { files }).catch((error: unknown) => error);
    expect(reads).toEqual([17]);
    expect((failure as GenerationCounterError).reason).toBe(TOO_LARGE);
  });

  it.for([
    ['run/current names 5', async (home: string, paths: Paths): Promise<void> => {
      await publish(home, paths, 5, '1.2.3');
    }, 6],
    ['g2 and g7 exist', async (home: string): Promise<void> => {
      makeStartingGeneration(home, 2, '1.2.3');
      makeStartingGeneration(home, 7, '1.2.3');
    }, 8],
    ['run/current names 3 and g9 exists', async (home: string, paths: Paths): Promise<void> => {
      await publish(home, paths, 3, '1.2.3');
      makeStartingGeneration(home, 9, '1.2.3');
    }, 10],
    ['nothing is recorded', async (): Promise<void> => undefined, 1],
  ] as const)('starts a home without a counter from the highest durable record when %s', async ([, prepare, expected], context) => {
    const { home, paths, lock } = await setup(context);
    await prepare(home, paths);
    expect(await start(paths, lock)).toMatchObject({ kind: 'allocated', generation: expected });
    expect(fs.readFileSync(paths.generationCounter, 'utf8')).toBe(`${expected}\n`);
  });

  it('refuses a number whose sockets do not fit with SocketPathUnsupportedError, and consumes no number', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '9');
    const fitting = Buffer.byteLength(layoutOf(home, 9).sockets.supervisor);
    setSocketBind(async (socketPath) => {
      if (Buffer.byteLength(socketPath) > fitting) throw Object.assign(new Error('name too long'), { code: 'EINVAL' });
    });
    registerCleanup(context, () => setSocketBind(undefined));
    const failure = await start(paths, lock).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SocketPathUnsupportedError);
    expect(fs.readFileSync(paths.generationCounter, 'utf8')).toBe('9');
    expect(generationDirs(paths)).toEqual([]);
  });
});

describe('a start whose allocation is withheld', () => {
  it('answers unallocated where it would allocate, and writes no counter, no generation and no lock', async (context) => {
    const { paths, lock } = await setup(context);

    expect(await start(paths, lock, '1.2.3', { allocation: 'withheld' })).toEqual({ kind: 'unallocated' });

    expect(fs.existsSync(paths.generationCounter)).toBe(false);
    expect(generationDirs(paths)).toEqual([]);
    expect(await lock.isHeld(paths.generationLock)).toBe(false);
  });

  it('allocates on the next start that allows it', async (context) => {
    const { paths, lock } = await setup(context);
    await start(paths, lock, '1.2.3', { allocation: 'withheld' });

    expect(await start(paths, lock, '1.2.3', { allocation: 'allowed' })).toMatchObject({ kind: 'allocated', generation: 1 });
  });

  it('still joins a start that another process began', async (context) => {
    const { home, paths, lock } = await setup(context);
    const layout = makeStartingGeneration(home, 1, '1.2.3');
    const claim = await lock.claim(layout.startingLock);
    if (claim.kind !== 'claimed') throw new Error('the starting lock of the fixture is held');

    expect(await start(paths, lock, '1.2.3', { allocation: 'withheld' })).toEqual({ kind: 'joined', generation: 1 });
  });
});

describe('the start record and the starting lock (15.2, 15.3 S1)', () => {
  it('writes start.json with the version of the start and the fold version', async (context) => {
    const { home, paths, lock } = await setup(context);
    await start(paths, lock);
    const record = JSON.parse(fs.readFileSync(layoutOf(home, 1).startRecord, 'utf8')) as StartRecord;
    expect(record).toEqual({ version: '1.2.3', foldVersion: FOLD_VERSION });
  });

  it('holds starting.lock past the return and releases run/generation.lock before it returns', async (context) => {
    const { home, paths, lock } = await setup(context);
    await start(paths, lock);
    expect(lock.claimsMade()).toContain(paths.generationLock);
    expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
    expect(lock.isHeldBy(layoutOf(home, 1).startingLock)).toBe('claim');
  });

  it('lets a second start request of the same version join the starting generation, with no counter write and no new directory', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    const starting = makeStartingGeneration(home, 2, '1.2.3');
    lock.holdExternally(starting.startingLock, 4242);
    const outcome = await start(paths, lock);
    expect(outcome).toEqual({ kind: 'joined', generation: 2 });
    expect(fs.readFileSync(paths.generationCounter, 'utf8')).toBe('2');
    expect(generationDirs(paths)).toEqual(['g2']);
  });

  it('joins a starting generation whose supervisor has already claimed its lock', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    const starting = makeStartingGeneration(home, 2, '1.2.4');
    lock.holdExternally(starting.locks.supervisor, 4243);
    const outcome = await start(paths, lock);
    expect(outcome).toEqual({ kind: 'joined', generation: 2 });
  });

  it('allocates above a starting generation older than the request', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    const starting = makeStartingGeneration(home, 2, '1.2.3');
    lock.holdExternally(starting.startingLock, 4242);
    const outcome = await start(paths, lock, '1.2.4');
    expect(outcome).toMatchObject({ kind: 'allocated', generation: 3 });
  });

  it('does not join a directory whose starter and supervisor are both gone', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '2');
    makeStartingGeneration(home, 2, '1.2.3');
    const outcome = await start(paths, lock);
    expect(outcome).toMatchObject({ kind: 'allocated', generation: 3 });
  });

  it('does not join a generation numbered below run/current, which is superseded', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '3');
    const superseded = makeStartingGeneration(home, 2, '1.2.3');
    lock.holdExternally(superseded.startingLock, 4242);
    await publish(home, paths, 3, '1.2.2');
    const outcome = await start(paths, lock);
    expect(outcome).toMatchObject({ kind: 'allocated', generation: 4 });
  });
});

describe('the decision against a live run/current, read from disk (15.4)', () => {
  it('starts nothing when the serving generation runs the client version', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '1');
    makeStartingGeneration(home, 1, '1.2.3');
    lock.holdExternally(layoutOf(home, 1).locks.supervisor, 4100);
    await publish(home, paths, 1, '1.2.3');
    const outcome = await start(paths, lock);
    expect(outcome).toEqual({ kind: 'serving', generation: 1, version: '1.2.3' });
    expect(counterOf(paths)).toBe(1);
  });

  it('allocates a newer generation beside an older serving one, and leaves the serving one in place', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '1');
    makeStartingGeneration(home, 1, '1.2.3');
    lock.holdExternally(layoutOf(home, 1).locks.supervisor, 4100);
    await publish(home, paths, 1, '1.2.3');
    const outcome = await start(paths, lock, '1.2.4');
    expect(outcome).toMatchObject({ kind: 'allocated', generation: 2 });
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toMatchObject({ generation: 1, version: '1.2.3' });
    expect(lock.isHeldBy(layoutOf(home, 1).locks.supervisor)).toBe('external');
  });

  it('refuses a client below the floor recorded in run/current when no generation serves, and allocates nothing', async (context) => {
    const { home, paths, lock } = await setup(context);
    writeCounter(paths, '1');
    await publish(home, paths, 1, '2.0.0');
    const outcome = await start(paths, lock, '1.9.0');
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
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toMatchObject({ kind: 'claimed' });
    expect(lock.isHeldBy(layout.locks.supervisor)).toBe('claim');
    expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
  });

  it('exits as an abandoned start when g<N>/ was reaped', async (context) => {
    const { home, paths, lock } = await setup(context);
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'abandoned', reason: 'directory-missing' });
    expect(fs.existsSync(layoutOf(home, 2).dir)).toBe(false);
    expect(lock.claimsMade()).not.toContain(layoutOf(home, 2).locks.supervisor);
  });

  it('exits as an abandoned start when start.json is missing', async (context) => {
    const { home, paths, lock } = await setup(context);
    fs.mkdirSync(layoutOf(home, 2).dir, { recursive: true });
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'abandoned', reason: 'record-missing' });
    expect(lock.isHeldBy(layoutOf(home, 2).locks.supervisor)).toBeUndefined();
  });

  it('exits as an abandoned start when start.json names another version', async (context) => {
    const { home, paths, lock } = await setup(context);
    makeStartingGeneration(home, 2, '1.2.4');
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'abandoned', reason: 'version-differs' });
    expect(lock.isHeldBy(layoutOf(home, 2).locks.supervisor)).toBeUndefined();
  });

  it('exits as an abandoned start when a reaper holds supervisor.lock', async (context) => {
    const { home, paths, lock } = await setup(context);
    const layout = makeStartingGeneration(home, 2, '1.2.3');
    lock.holdExternally(layout.locks.supervisor, 4300);
    expect(await i3.claimGeneration(paths, 2, { version: '1.2.3', lock })).toEqual({ kind: 'abandoned', reason: 'lock-held' });
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
  ] as const)('answers superseded and leaves run/current byte for byte when the publish carries %s', async ([, generation], context) => {
    const { home, paths } = await setup(context);
    expect(await publish(home, paths, 3, '1.2.3')).toBe('published');
    const before = fs.readFileSync(paths.current, 'utf8');
    const inode = fs.statSync(paths.current).ino;
    expect(await publish(home, paths, generation, '1.2.4')).toBe('superseded');
    expect(fs.readFileSync(paths.current, 'utf8')).toBe(before);
    expect(fs.statSync(paths.current).ino).toBe(inode);
  });

  it('replaces run/current when the number is above the current one', async (context) => {
    const { home, paths } = await setup(context);
    await publish(home, paths, 3, '1.2.3');
    expect(await publish(home, paths, 4, '1.2.4')).toBe('published');
    expect(fs.readFileSync(paths.current, 'utf8')).toBe(`${JSON.stringify({ generation: 4, version: '1.2.4', sockets: generationLayout(home, 4).sockets })}\n`);
  });

  it('answers busy and leaves run/current byte for byte while run/generation.lock is held, and releases the lock after a publish', async (context) => {
    const { home, paths, lock } = await setup(context);
    const record = (generation: number) => ({ generation, version: '1.2.3', sockets: generationLayout(home, generation).sockets });
    expect(await publishCurrentGeneration(paths, record(3), { lock })).toBe('published');
    expect(lock.claimsMade()[0]).toBe(paths.generationLock);
    expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
    const before = fs.readFileSync(paths.current, 'utf8');
    const inode = fs.statSync(paths.current).ino;
    lock.holdExternally(paths.generationLock, 4500);
    expect(await publishCurrentGeneration(paths, record(4), { lock })).toBe('busy');
    expect(fs.readFileSync(paths.current, 'utf8')).toBe(before);
    expect(fs.statSync(paths.current).ino).toBe(inode);
  });
});

describe('the order of S1 and its failures (15.3 S1, 20.8)', () => {
  const recordingWorld = (paths: Paths, home: string, lock: FakeKernelLock, order: string[]) => {
    const nameOf = (file: string): string => path.relative(paths.run, file);
    const recordingLock: KernelLockMechanism = {
      ...lock,
      claim: async (lockPath) => {
        const outcome = await lock.claim(lockPath);
        if (lockPath !== paths.generationLock && !lockPath.endsWith('starting.lock')) return outcome;
        order.push(`claim ${nameOf(lockPath)}`);
        if (outcome.kind !== 'claimed') return outcome;
        return { kind: 'claimed', lock: { ...outcome.lock, release: () => {
          order.push(`release ${nameOf(lockPath)}`);
          outcome.lock.release();
        } } };
      },
    };
    const files: GenerationStartFiles = {
      ...nodeGenerationStartFiles,
      atomic: { ...nodeGenerationStartFiles.atomic, rename: async (from, to) => {
        order.push(`write ${nameOf(to)}`);
        await nodeGenerationStartFiles.atomic.rename(from, to);
      } },
      createGenerationDirs: async (given, generation) => {
        order.push(`mkdir g${generation}`);
        await nodeGenerationStartFiles.createGenerationDirs(given, generation);
      },
    };
    setSocketBind(async () => void order.push('socket check'));
    return { recordingLock, files, home };
  };

  it('checks the path, writes the counter, makes the directories, writes start.json, claims starting.lock and then releases the lock', async (context) => {
    const { home, paths, lock } = await setup(context);
    const order: string[] = [];
    const { recordingLock, files } = recordingWorld(paths, home, lock, order);
    registerCleanup(context, () => setSocketBind(undefined));
    await start(paths, recordingLock, '1.2.3', { files });
    expect(order).toEqual(['claim generation.lock', 'socket check', 'write generation.counter', 'mkdir g1', 'write g1/start.json', 'claim g1/starting.lock', 'release generation.lock']);
    expect(lock.isHeldBy(layoutOf(home, 1).startingLock)).toBe('claim');
    expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
    expect(fs.existsSync(scopeToGeneration(paths, 1).markers.daemons)).toBe(true);
  });

  it.for([['the counter write', 'write generation.counter'], ['the directory', 'mkdir g1'], ['start.json', 'write g1/start.json'], ['the starting-lock claim', 'claim g1/starting.lock']] as const)(
    'a failure at %s leaves no lock held and no number to reuse',
    async ([, failingStep], context) => {
      const { home, paths, lock } = await setup(context);
      const order: string[] = [];
      const { recordingLock, files } = recordingWorld(paths, home, lock, order);
      registerCleanup(context, () => setSocketBind(undefined));
      const boom = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      const failing: GenerationStartFiles = {
        ...files,
        atomic: { ...files.atomic, rename: async (from, to) => {
          if (`write ${path.relative(paths.run, to)}` === failingStep) throw boom;
          await files.atomic.rename(from, to);
        } },
        createGenerationDirs: async (given, generation) => {
          if (failingStep === 'mkdir g1') throw boom;
          await files.createGenerationDirs(given, generation);
        },
      };
      const failingLock: KernelLockMechanism = { ...recordingLock, claim: async (lockPath): ReturnType<KernelLockMechanism['claim']> => {
        if (failingStep === 'claim g1/starting.lock' && lockPath.endsWith('starting.lock')) throw boom;
        return recordingLock.claim(lockPath);
      } };
      const failure = await start(paths, failingLock, '1.2.3', { files: failing }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GenerationPrepareError);
      expect((failure as Error).message).toBe('could not prepare generation 1: ENOSPC no space left');
      expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
      expect(lock.isHeldBy(layoutOf(home, 1).startingLock)).toBeUndefined();
      const written = fs.existsSync(paths.generationCounter) ? counterOf(paths) : 0;
      setSocketBind(undefined);
      const next = await start(paths, lock);
      expect(next).toMatchObject({ kind: 'allocated', generation: written + 1 });
    },
  );
});

describe('the other triggers and the remaining outcomes (15.14 P3, P4, P10, I-1)', () => {
  const serving = async (home: string, paths: Paths, lock: FakeKernelLock, version: string): Promise<void> => {
    writeCounter(paths, '1');
    makeStartingGeneration(home, 1, version);
    lock.holdExternally(layoutOf(home, 1).locks.supervisor, 4100);
    await publish(home, paths, 1, version);
  };

  it('answers older, decided under the lock, for a client older than the serving generation, and makes nothing', async (context) => {
    const { home, paths, lock } = await setup(context);
    await serving(home, paths, lock, '1.2.3');
    lock.holdExternally(makeStartingGeneration(home, 2, '1.2.2').startingLock, 4242);
    expect(await start(paths, lock, '1.2.2')).toEqual({ kind: 'older', version: '1.2.3' });
    expect(lock.claimsMade()).toEqual([paths.generationLock]);
    expect(fs.readFileSync(paths.generationCounter, 'utf8')).toBe('1');
    expect(generationDirs(paths)).toEqual(['g1', 'g2']);
  });

  it('answers busy after one claim attempt while run/generation.lock is held, and writes nothing', async (context) => {
    const { paths, lock } = await setup(context);
    lock.holdExternally(paths.generationLock, 4600);
    expect(await start(paths, lock)).toEqual({ kind: 'busy' });
    expect(lock.claimsMade()).toEqual([]);
    expect(fs.existsSync(paths.generationCounter)).toBe(false);
    expect(generationDirs(paths)).toEqual([]);
  });

  it('trigger restart allocates a generation of the serving version and never joins a pending start', async (context) => {
    const { home, paths, lock } = await setup(context);
    await serving(home, paths, lock, '1.2.3');
    writeCounter(paths, '2');
    lock.holdExternally(makeStartingGeneration(home, 2, '1.2.3').startingLock, 4242);
    expect(await start(paths, lock, '1.2.3', { trigger: 'restart' })).toMatchObject({ kind: 'allocated', generation: 3 });
    expect(JSON.parse(fs.readFileSync(layoutOf(home, 3).startRecord, 'utf8'))).toEqual({ version: '1.2.3', foldVersion: FOLD_VERSION });
  });

  it('trigger childMismatch allocates at a newer installed version', async (context) => {
    const { home, paths, lock } = await setup(context);
    await serving(home, paths, lock, '9.9.9');
    expect(await start(paths, lock, '9.9.10', { trigger: 'childMismatch' })).toMatchObject({ kind: 'allocated', generation: 2 });
    expect(JSON.parse(fs.readFileSync(layoutOf(home, 2).startRecord, 'utf8'))).toEqual({ version: '9.9.10', foldVersion: FOLD_VERSION });
  });

  it('trigger childMismatch joins a start of at least the installed version', async (context) => {
    const { home, paths, lock } = await setup(context);
    await serving(home, paths, lock, '9.9.9');
    writeCounter(paths, '2');
    lock.holdExternally(makeStartingGeneration(home, 2, '9.9.10').startingLock, 4242);
    expect(await start(paths, lock, '9.9.10', { trigger: 'childMismatch' })).toEqual({ kind: 'joined', generation: 2 });
  });

  it('trigger childMismatch refuses an older installed version below the floor and writes nothing', async (context) => {
    const { home, paths, lock } = await setup(context);
    await serving(home, paths, lock, '9.9.9');
    expect(await start(paths, lock, '9.9.8', { trigger: 'childMismatch' })).toEqual({ kind: 'below-floor', floor: '9.9.9' });
    expect(fs.readFileSync(paths.generationCounter, 'utf8')).toBe('1');
    expect(generationDirs(paths)).toEqual(['g1']);
  });

  it('decides restart as an allocation whatever the view, and childMismatch by the order of the installed version', () => {
    const current = { generation: 3, version: '1.2.3' };
    const starting = [{ generation: 4, version: '1.2.9' }];
    expect(decideGenerationStart({ trigger: 'restart', clientVersion: '1.2.3', current, serving: true, starting })).toEqual({ kind: 'allocate' });
    expect(decideGenerationStart({ trigger: 'childMismatch', clientVersion: '1.2.4', current, serving: true, starting })).toEqual({ kind: 'join', generation: 4 });
    expect(decideGenerationStart({ trigger: 'childMismatch', clientVersion: '1.2.4', current, serving: true, starting: [] })).toEqual({ kind: 'allocate' });
    expect(decideGenerationStart({ trigger: 'childMismatch', clientVersion: '1.2.2', current, serving: true, starting })).toEqual({ kind: 'below-floor', floor: '1.2.3' });
  });

  it('treats versions that cannot be ordered as an older client, and starts nothing (20.17)', () => {
    const current = { generation: 3, version: '1.2.3' };
    expect(decideGenerationStart({ clientVersion: 'e2e', current, serving: true, starting: [] })).toEqual({ kind: 'older', version: '1.2.3' });
  });

  it('refuses a start with the settled text when run/current cannot be read', async (context) => {
    const { paths, lock } = await setup(context);
    fs.writeFileSync(paths.current, '[]');
    const failure = await start(paths, lock).catch((error: unknown) => error);
    expect((failure as Error).message).toBe(`momonga cannot read ${paths.current}: it is not an object. No generation was started. Repair or remove the file, then run the command again.`);
    expect(lock.isHeldBy(paths.generationLock)).toBeUndefined();
    expect(generationDirs(paths)).toEqual([]);
  });

  it('writes start.json as JSON plus one LF with mode 0600 and exactly the two keys', async (context) => {
    const { home, paths, lock } = await setup(context);
    await start(paths, lock);
    const file = layoutOf(home, 1).startRecord;
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":"1.2.3","foldVersion":1}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('fails a starter whose own directory is gone', () => {
    const own = { generation: 2, version: '1.2.3' };
    expect(starterOutcome({ own, currentHeld: false, currentDraining: false, ownSupervisorGone: false, ownDirectoryGone: true })).toBe('failed');
  });

  it('reads a lock probe that cannot answer as live (20.24)', async (context) => {
    const { home, paths, lock } = await setup(context);
    makeStartingGeneration(home, 2, '1.2.3');
    const throwing: KernelLockMechanism = { ...lock, isHeld: async () => Promise.reject(new Error('probe failed')) };
    expect(await generationIsLive(paths, 2, { lock: throwing })).toBe(true);
  });
});

describe('the generation directories and the role source (20.2, 20.4, 20.7)', () => {
  it('requireGenerationDirs throws the settled error when run/g<N> is missing, and passes for a prepared generation', async (context) => {
    const { home, paths } = await setup(context);
    const failure = await requireGenerationDirs(paths, 3).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GenerationDirectoryMissingError);
    expect((failure as Error).message).toBe(`the directory of generation 3 is missing: ${layoutOf(home, 3).dir}`);
    expect(fs.existsSync(layoutOf(home, 3).dir)).toBe(false);
    prepareGenerationForTest(home, 3, '1.2.3');
    await expect(requireGenerationDirs(paths, 3)).resolves.toBeUndefined();
  });

  it('scopes the marker, job and spawn-scratch paths to the generation and keeps the call locks shared', (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    const scoped = scopeToGeneration(paths, 7);
    expect(scoped.markers).toEqual({
      root: path.join(paths.markers.root, 'g7'),
      tools: path.join(paths.markers.root, 'g7', 'tools'),
      mcp: path.join(paths.markers.root, 'g7', 'mcp'),
      targets: path.join(paths.markers.root, 'g7', 'targets'),
      daemons: path.join(paths.markers.root, 'g7', 'daemons'),
    });
    expect(scoped.jobs).toBe(path.join(paths.run, 'g7', 'jobs'));
    expect(scoped.tmp.spawn).toBe(path.join(paths.tmp.spawn, 'g7'));
    expect(scoped.callLocks).toBe(paths.callLocks);
  });

  it('reads the role from run/current: starting before it names the generation, serving when it does, retiring above it', async (context) => {
    const { home, paths } = await setup(context);
    expect(await readGenerationRole(paths, 2)).toBe('starting');
    await publish(home, paths, 1, '1.2.3');
    expect(await readGenerationRole(paths, 2)).toBe('starting');
    await publish(home, paths, 2, '1.2.3');
    expect(await readGenerationRole(paths, 2)).toBe('serving');
    await publish(home, paths, 3, '1.2.3');
    expect(await readGenerationRole(paths, 2)).toBe('retiring');
    fs.writeFileSync(paths.current, 'not json');
    expect(await readGenerationRole(paths, 2)).toMatchObject({ kind: 'unreadable' });
  });
});
