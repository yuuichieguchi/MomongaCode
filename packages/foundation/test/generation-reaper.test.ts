import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GENERATION_REAPER_STEPS,
  beginGenerationStart,
  claimGeneration,
  generationLayout,
  generationMarkerDirectories,
  generationSpawnScratch,
  kernelLockNamed,
  momongaPaths,
  nodeGenerationReaperFiles,
  publishCurrentGeneration,
  reapDeadGenerations,
} from '@momonga/foundation';
import type { GenerationLayout, GenerationReaperFiles, GenerationReaperOptions, GenerationReaperResult, HeldKernelLock, KernelLockMechanism, MarkerKind, MomongaPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeKernelLock, prepareGenerationForTest, startGenerationForTest, startLockHolder, testKernelLock } from '@momonga/testkit';
import type { TrackedChild } from '@momonga/testkit';
import { exitOf } from './support/lock-processes.ts';
import { seededRandom } from './seeded-random.ts';
import { makeShortHomeDirectory } from './support/temporary-directory.ts';

const UNIX_ENDPOINTS = { form: 'unix' } as const;

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const VERSION = '1.2.3';

const FILE_OPERATIONS = ['readdir', 'markerFiles', 'mkdir', 'unlink', 'rmdir', 'removeTree'] as const;

const CHANGING = /^(claim|release|dispose|mkdir|unlink|rmdir|removeTree|reap) /;

type Setup = { home: string; paths: MomongaPaths; layout(generation: number): GenerationLayout; prepare(generation: number): GenerationLayout };

const setup = (): Setup => {
  const home = makeShortHomeDirectory();
  const paths = momongaPaths(home, process.platform, {});
  fs.mkdirSync(paths.markers.root, { recursive: true, mode: 0o700 });
  return { home, paths, layout: (generation) => generationLayout(home, generation), prepare: (generation) => prepareGenerationForTest(home, generation, VERSION) };
};

const errno = (code: string, target: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: ${target}`), { code, path: target });

const recordingFiles = (log: string[], failing: Map<string, string> = new Map(), before: () => void = () => undefined): GenerationReaperFiles => {
  const recorded = <Result>(name: (typeof FILE_OPERATIONS)[number], work: (target: string) => Promise<Result>) => async (target: string): Promise<Result> => {
    before();
    const line = `${name} ${target}`;
    log.push(line);
    const code = failing.get(line);
    if (code !== undefined) throw errno(code, target);
    return work(target);
  };
  return {
    readdir: recorded('readdir', nodeGenerationReaperFiles.readdir),
    markerFiles: recorded('markerFiles', nodeGenerationReaperFiles.markerFiles),
    mkdir: recorded('mkdir', nodeGenerationReaperFiles.mkdir),
    unlink: recorded('unlink', nodeGenerationReaperFiles.unlink),
    rmdir: recorded('rmdir', nodeGenerationReaperFiles.rmdir),
    removeTree: recorded('removeTree', nodeGenerationReaperFiles.removeTree),
  };
};

const recordingLock = (log: string[], lock: KernelLockMechanism): KernelLockMechanism => ({
  ...lock,
  isHeld: async (lockPath) => {
    log.push(`probe ${lockPath}`);
    return lock.isHeld(lockPath);
  },
  claim: async (lockPath) => {
    const outcome = await lock.claim(lockPath);
    log.push(`claim ${lockPath}${outcome.kind === 'held' ? ' held' : ''}`);
    if (outcome.kind === 'held') return outcome;
    const held = outcome.lock;
    let open = true;
    const recording: HeldKernelLock = {
      descriptor: held.descriptor,
      writeHolder: (text) => held.writeHolder(text),
      release: () => {
        if (open) log.push(`release ${lockPath}`);
        open = false;
        held.release();
      },
      dispose: () => {
        if (open) log.push(`dispose ${lockPath}`);
        open = false;
        held.dispose();
      },
    };
    return { kind: 'claimed', lock: recording };
  },
});

type PassOverrides = Partial<Omit<GenerationReaperOptions, 'paths'>>;

const passOf = (paths: MomongaPaths, warnings: string[], overrides: PassOverrides = {}): Promise<GenerationReaperResult> =>
  reapDeadGenerations({
    paths,
    lock: testKernelLock(),
    signal: new AbortController().signal,
    warn: (message) => warnings.push(message),
    reapMarkers: async () => undefined,
    ...overrides,
  });

const kill = async (child: TrackedChild): Promise<void> => {
  child.kill('SIGKILL');
  await exitOf(child);
};

const touch = (file: string, content = ''): void => fs.writeFileSync(file, content, { mode: 0o600 });

const fillGeneration = (s: Setup, generation: number): GenerationLayout => {
  const layout = s.prepare(generation);
  const targets = path.join(layout.dir, 'targets');
  fs.mkdirSync(targets, { mode: 0o700 });
  fs.mkdirSync(path.join(layout.dir, 'jobs'), { mode: 0o700 });
  for (const stem of ['apple-1', '_probe-apple']) for (const suffix of ['.sock', '.lock']) touch(path.join(targets, `${stem}${suffix}`));
  for (const name of ['supervisor.lock', 'starting.lock', 'runtime.lock', 'gateway.lock', 'gateway.sock', 'gateway.sock.lock', 'settings-applied.json']) touch(path.join(layout.dir, name));
  fs.mkdirSync(generationSpawnScratch(s.paths, generation), { recursive: true, mode: 0o700 });
  return layout;
};

describe('T-L2-18: the steps of the reaper are data', () => {
  it('lists the five steps of 14.5 in their order', () => {
    expect(GENERATION_REAPER_STEPS).toEqual(['claim-dead', 'reap-markers', 'claim-members', 'remove-members', 'remove-directory']);
  });
});

describe('T-L2-1 and T-L2-2 (14.4 A2, 15.8): the start window, with real kernel locks', () => {
  it('claims nothing and removes nothing while another process holds run/generation.lock, and says busy', async (context) => {
    const s = setup();
    const layout = s.prepare(2);
    await startLockHolder(context, s.paths.generationLock);
    const warnings: string[] = [];
    await expect(passOf(s.paths, warnings)).resolves.toEqual({ removed: [], kept: [], busy: true });
    expect(fs.readdirSync(layout.dir)).toEqual(['start.json']);
    expect(warnings).toEqual([]);
  });

  it('keeps a generation whose starter holds starting.lock, and removes it only after the starter was killed', async (context) => {
    const s = setup();
    const layout = s.prepare(3);
    const starter = await startLockHolder(context, layout.startingLock);
    await expect(passOf(s.paths, [])).resolves.toEqual({ removed: [], kept: [], busy: false });
    expect(fs.existsSync(layout.dir)).toBe(true);
    expect(fs.existsSync(layout.markers)).toBe(true);
    await kill(starter);
    await expect(passOf(s.paths, [])).resolves.toEqual({ removed: [3], kept: [], busy: false });
    expect(fs.existsSync(layout.dir)).toBe(false);
    expect(fs.existsSync(layout.markers)).toBe(false);
  });
});

describe('T-L2-1 and T-L2-2 under the sqlite mechanism, named by the test, not by the host', () => {
  it('keeps a generation whose starter holds starting.lock, and removes it only after the starter was killed', async (context) => {
    const s = setup();
    const layout = s.prepare(3);
    const lock = kernelLockNamed('sqlite-lock');
    const starter = await startLockHolder(context, layout.startingLock, 'sqlite-lock');
    await expect(passOf(s.paths, [], { lock })).resolves.toEqual({ removed: [], kept: [], busy: false });
    expect(fs.existsSync(layout.dir)).toBe(true);
    await kill(starter);
    await expect(passOf(s.paths, [], { lock })).resolves.toEqual({ removed: [3], kept: [], busy: false });
    expect(fs.existsSync(layout.dir)).toBe(false);
  });

  it('removes a generation whose supervisor was killed while it held supervisor.lock under sqlite', async (context) => {
    const s = setup();
    const layout = s.prepare(4);
    const lock = kernelLockNamed('sqlite-lock');
    const supervisor = await startLockHolder(context, layout.locks.supervisor, 'sqlite-lock');
    await expect(passOf(s.paths, [], { lock })).resolves.toEqual({ removed: [], kept: [], busy: false });
    await kill(supervisor);
    await expect(passOf(s.paths, [], { lock })).resolves.toEqual({ removed: [4], kept: [], busy: false });
  });
});

describe('T-L2-3 (14.5 step 1): a live generation is never touched', () => {
  it('reads, claims and removes nothing under run/g2 and run/markers/g2 while its supervisor lock is held', async (context) => {
    const s = setup();
    const layout = fillGeneration(s, 2);
    await startLockHolder(context, layout.locks.supervisor);
    const log: string[] = [];
    const reaped: number[] = [];
    const result = await passOf(s.paths, [], {
      files: recordingFiles(log),
      lock: recordingLock(log, testKernelLock()),
      reapMarkers: async ({ generation }) => {
        reaped.push(generation);
      },
    });
    expect(result).toEqual({ removed: [], kept: [], busy: false });
    expect(reaped).toEqual([]);
    expect(log.filter((line) => !line.startsWith('probe ') && (line.includes(layout.dir) || line.includes(layout.markers)))).toEqual([]);
    expect(fs.existsSync(path.join(layout.dir, 'targets', 'apple-1.sock'))).toBe(true);
  });
});

describe('T-L2-4 (14.5, 15.8, 18.9a, 20.64): the steps for a dead generation, in order', () => {
  it('claims under run/generation.lock, reaps the markers, claims every member lock, then removes, supervisor.lock last', async () => {
    const s = setup();
    const layout = fillGeneration(s, 1);
    const targets = path.join(layout.dir, 'targets');
    const log: string[] = [];
    const fake = createFakeKernelLock({ inheritable: false });
    const result = await passOf(s.paths, [], {
      files: recordingFiles(log),
      lock: recordingLock(log, fake),
      reapMarkers: async ({ kind, directory }) => {
        log.push(`reap ${kind} ${directory}`);
      },
    });
    const markers = generationMarkerDirectories(s.paths, 1);
    expect(result).toEqual({ removed: [1], kept: [], busy: false });
    expect(log.filter((line) => CHANGING.test(line))).toEqual([
      `claim ${s.paths.generationLock}`,
      `claim ${layout.startingLock}`,
      `claim ${layout.locks.supervisor}`,
      `release ${s.paths.generationLock}`,
      `reap daemons ${markers.daemons}`,
      `reap mcp ${markers.mcp}`,
      `reap tools ${markers.tools}`,
      `reap targets ${markers.targets}`,
      `claim ${layout.locks.runtime}`,
      `claim ${layout.locks.gateway}`,
      `claim ${path.join(targets, '_probe-apple.lock')}`,
      `claim ${path.join(targets, 'apple-1.lock')}`,
      `removeTree ${layout.markers}`,
      `unlink ${path.join(targets, '_probe-apple.sock')}`,
      `dispose ${path.join(targets, '_probe-apple.lock')}`,
      `unlink ${path.join(targets, 'apple-1.sock')}`,
      `dispose ${path.join(targets, 'apple-1.lock')}`,
      `removeTree ${targets}`,
      `unlink ${path.join(layout.dir, 'gateway.sock')}`,
      `unlink ${path.join(layout.dir, 'gateway.sock.lock')}`,
      `rmdir ${path.join(layout.dir, 'jobs')}`,
      `unlink ${layout.settingsApplied}`,
      `unlink ${layout.startRecord}`,
      `rmdir ${generationSpawnScratch(s.paths, 1)}`,
      `dispose ${layout.locks.runtime}`,
      `dispose ${layout.locks.gateway}`,
      `dispose ${layout.startingLock}`,
      `dispose ${layout.locks.supervisor}`,
      `rmdir ${layout.dir}`,
    ]);
    expect(fs.existsSync(layout.dir)).toBe(false);
    expect(fs.existsSync(layout.markers)).toBe(false);
    expect(fs.existsSync(generationSpawnScratch(s.paths, 1))).toBe(false);
  });
});

describe('T-L2-5 (14.5 step 3, 20.62): markers before removal, and a process that cannot be stopped', () => {
  it('keeps everything while a marker whose sweep chance is spent remains, tells the person once per pass, and removes the directory once the marker is ignored', async () => {
    const s = setup();
    const layout = fillGeneration(s, 1);
    const marker = path.join(generationMarkerDirectories(s.paths, 1).tools, 'call-1');
    touch(marker, 'r01000\n');
    const fake = createFakeKernelLock({ inheritable: false });
    const log: string[] = [];
    const warnings: string[] = [];
    const overrides: PassOverrides = { files: recordingFiles(log), lock: recordingLock(log, fake) };
    await expect(passOf(s.paths, warnings, overrides)).resolves.toEqual({ removed: [], kept: [1], busy: false });
    expect(log.filter((line) => /^(unlink|rmdir|removeTree|dispose) /.test(line))).toEqual([]);
    expect(log).toContain(`release ${layout.locks.supervisor}`);
    expect(fake.isHeldBy(layout.locks.supervisor)).toBeUndefined();
    expect(fake.isHeldBy(layout.startingLock)).toBeUndefined();
    expect(fs.existsSync(path.join(layout.dir, 'supervisor.lock'))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('a tool process (marker call-1) may still be running');
    expect(warnings[0]).toContain('/markers ignore call-1');
    touch(marker, 'r01001\n');
    await expect(passOf(s.paths, warnings, overrides)).resolves.toEqual({ removed: [1], kept: [], busy: false });
    expect(fs.existsSync(layout.markers)).toBe(false);
    expect(fs.existsSync(layout.dir)).toBe(false);
  });

  it('keeps the directory without the final notice while a remaining marker still has its sweep chance', async () => {
    const s = setup();
    const layout = s.prepare(1);
    const marker = path.join(generationMarkerDirectories(s.paths, 1).mcp, 'server-1');
    touch(marker);
    const warnings: string[] = [];
    await expect(passOf(s.paths, warnings, { lock: createFakeKernelLock({ inheritable: false }) })).resolves.toEqual({ removed: [], kept: [1], busy: false });
    expect(warnings).toEqual([`leftover cleanup kept ${marker}: its process was not stopped`]);
    expect(fs.existsSync(layout.dir)).toBe(true);
  });

  it('keeps the directory and reports the marker directory when the marker reap fails', async () => {
    const s = setup();
    const layout = s.prepare(1);
    const warnings: string[] = [];
    const result = await passOf(s.paths, warnings, {
      lock: createFakeKernelLock({ inheritable: false }),
      reapMarkers: async ({ kind }) => {
        if (kind === 'mcp') throw errno('EPERM', 'probe');
      },
    });
    expect(result).toEqual({ removed: [], kept: [1], busy: false });
    expect(warnings).toEqual([`leftover cleanup kept ${generationMarkerDirectories(s.paths, 1).mcp}: EPERM`]);
    expect(fs.existsSync(layout.markers)).toBe(true);
  });
});

describe('T-L2-6 (14.5 step 4, 20.64): a held child lock stops the reaper', () => {
  it('removes nothing and gives supervisor.lock back without unlinking it', async () => {
    const s = setup();
    const layout = fillGeneration(s, 1);
    const fake = createFakeKernelLock({ inheritable: false });
    fake.holdExternally(layout.locks.runtime, 4242);
    const log: string[] = [];
    const warnings: string[] = [];
    await expect(passOf(s.paths, warnings, { files: recordingFiles(log), lock: recordingLock(log, fake) })).resolves.toEqual({ removed: [], kept: [1], busy: false });
    expect(log.filter((line) => /^(unlink|rmdir|removeTree|dispose) /.test(line))).toEqual([]);
    expect(fake.isHeldBy(layout.locks.supervisor)).toBeUndefined();
    expect(fs.existsSync(layout.locks.supervisor)).toBe(true);
    expect(fs.existsSync(layout.markers)).toBe(true);
    expect(warnings).toEqual([`leftover cleanup kept ${layout.locks.runtime}: its lock is held`]);
  });
});

describe('T-L2-7 (18.9a): every instance lock is claimed before targets/ goes', () => {
  it('keeps targets/ whole while one instance lock is held by a live process, and removes the generation once it is free', async (context) => {
    const s = setup();
    const layout = fillGeneration(s, 1);
    const targets = path.join(layout.dir, 'targets');
    const instance = await startLockHolder(context, path.join(targets, 'apple-1.lock'));
    const warnings: string[] = [];
    await expect(passOf(s.paths, warnings)).resolves.toEqual({ removed: [], kept: [1], busy: false });
    expect(fs.existsSync(path.join(targets, 'apple-1.sock'))).toBe(true);
    expect(fs.existsSync(path.join(targets, '_probe-apple.sock'))).toBe(true);
    expect(warnings).toEqual([`leftover cleanup kept ${path.join(targets, 'apple-1.lock')}: its lock is held`]);
    await kill(instance);
    await expect(passOf(s.paths, warnings)).resolves.toEqual({ removed: [1], kept: [], busy: false });
    expect(fs.existsSync(layout.dir)).toBe(false);
  });
});

describe('T-L2-8 (14.11 T5): numbers after a reap', () => {
  it('gives the next start a higher number after the generation was reaped, and after a crash between the counter and the directory', async () => {
    const s = setup();
    const first = await startGenerationForTest(s.home, { version: VERSION });
    first.release();
    await expect(passOf(s.paths, [])).resolves.toEqual({ removed: [first.generation], kept: [], busy: false });
    const second = await startGenerationForTest(s.home, { version: VERSION });
    second.release();
    expect(second.generation).toBeGreaterThan(first.generation);
    fs.writeFileSync(s.paths.generationCounter, `${second.generation + 5}\n`);
    await passOf(s.paths, []);
    const third = await startGenerationForTest(s.home, { version: VERSION });
    third.release();
    expect(third.generation).toBe(second.generation + 6);
  });
});

const dial = (socketPath: string): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'));
  });

describe('T-L2-9 (14.4, 14.11 T6): a dial during and after a removal', () => {
  it('never fails a dial to a live generation during the pass, and a dial to the removed one finds no daemon', async () => {
    const s = setup();
    const dead = fillGeneration(s, 1);
    const live = s.prepare(2);
    const lock = testKernelLock();
    const held = await lock.claim(live.locks.supervisor);
    if (held.kind !== 'claimed') throw new Error('the test could not claim the live supervisor lock');
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(live.sockets.supervisor, resolve));
    try {
      const [result, dials] = await Promise.all([passOf(s.paths, [], { lock }), Promise.all(Array.from({ length: 100 }, () => dial(live.sockets.supervisor)))]);
      expect(result).toEqual({ removed: [1], kept: [], busy: false });
      expect(dials.filter((outcome) => outcome !== 'connected')).toEqual([]);
      expect(['ENOENT', 'ECONNREFUSED']).toContain(await dial(dead.sockets.supervisor));
      expect(fs.existsSync(live.dir)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      held.lock.release();
    }
  });
});

describe('T-L2-10 (15.3 S2, 15.8): a late supervisor loses to the reaper', () => {
  it('abandons its start with lock-held while the reaper holds supervisor.lock, and the reaper finishes', async () => {
    const s = setup();
    const layout = s.prepare(2);
    const fake = createFakeKernelLock({ inheritable: false });
    let entered = (): void => undefined;
    let leave = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      leave = resolve;
    });
    const pass = passOf(s.paths, [], {
      lock: fake,
      reapMarkers: async ({ kind }) => {
        if (kind !== 'daemons') return;
        entered();
        await released;
      },
    });
    await inside;
    await expect(claimGeneration(s.paths, 2, { version: VERSION, lock: fake })).resolves.toEqual({ kind: 'abandoned', reason: 'lock-held' });
    leave();
    await expect(pass).resolves.toEqual({ removed: [2], kept: [], busy: false });
    expect(fs.existsSync(layout.dir)).toBe(false);
  });
});

describe('T-L2-11 (18.2.7, 20.66): the reaper lists only generation directories', () => {
  it('reads, claims and removes none of the unscoped entries of run/', async () => {
    const s = setup();
    s.prepare(1);
    const files = ['current', 'generation.lock', 'generation.counter', 'update.lock', '_cli-probe-apple.sock', '_cli-probe-apple.lock'].map((name) => path.join(s.paths.run, name));
    const directories = ['lock-proof', 'grep-arguments', 'call-locks', 'handover', path.join('markers', 'cli', 'probe-apple')].map((name) => path.join(s.paths.run, name));
    for (const directory of directories) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of files) touch(file, 'kept');
    touch(path.join(s.paths.markers.root, 'cli', 'probe-apple', 'marker'), 'r00000\n');
    const log: string[] = [];
    await expect(passOf(s.paths, [], { files: recordingFiles(log), lock: recordingLock(log, createFakeKernelLock({ inheritable: false })) })).resolves.toEqual({ removed: [1], kept: [], busy: false });
    const touched = log.filter((line) => line !== `claim ${s.paths.generationLock}` && line !== `release ${s.paths.generationLock}`);
    for (const entry of [...files, ...directories, path.join(s.paths.markers.root, 'cli')]) {
      expect(touched.filter((line) => line.split(' ')[1]?.startsWith(entry)), entry).toEqual([]);
    }
    for (const file of files) expect(fs.readFileSync(file, 'utf8'), file).toBe('kept');
    expect(fs.existsSync(path.join(s.paths.markers.root, 'cli', 'probe-apple', 'marker'))).toBe(true);
    expect(log.filter((line) => line === `readdir ${s.paths.run}`)).toHaveLength(2);
    expect(log.filter((line) => line === `readdir ${s.paths.markers.root}`)).toHaveLength(1);
  });
});

describe('T-L2-12 (15.4): run/current survives the reap of the generation it names', () => {
  it('leaves the file byte for byte, so its version stays the floor', async () => {
    const s = setup();
    const lock = testKernelLock();
    const layout = s.prepare(1);
    await publishCurrentGeneration(s.paths, { generation: 1, version: '2.0.0', sockets: layout.sockets }, { lock });
    const before = fs.readFileSync(s.paths.current);
    await expect(passOf(s.paths, [], { lock })).resolves.toEqual({ removed: [1], kept: [], busy: false });
    expect(fs.readFileSync(s.paths.current).equals(before)).toBe(true);
    await expect(beginGenerationStart(s.paths, { version: '1.0.0', foldVersion: 1, lock, scope: UNIX_ENDPOINTS })).resolves.toEqual({ kind: 'below-floor', floor: '2.0.0' });
  });
});

describe('T-L2-13 (14.16 S7, 20.62, 20.64): an error on one entry keeps it and the pass goes on', () => {
  it('reports the entry once, releases its claims, removes the next dead generation and resolves', async () => {
    const s = setup();
    const first = fillGeneration(s, 1);
    const second = fillGeneration(s, 2);
    const fake = createFakeKernelLock({ inheritable: false });
    const warnings: string[] = [];
    const failing = new Map([[`unlink ${first.startRecord}`, 'EACCES']]);
    await expect(passOf(s.paths, warnings, { files: recordingFiles([], failing), lock: fake })).resolves.toEqual({ removed: [2], kept: [1], busy: false });
    expect(warnings).toEqual([`leftover cleanup kept ${first.startRecord}: EACCES`]);
    expect(fs.existsSync(second.dir)).toBe(false);
    expect(fs.existsSync(first.startRecord)).toBe(true);
    expect(fake.isHeldBy(first.locks.supervisor)).toBeUndefined();
    await expect(passOf(s.paths, warnings, { lock: fake })).resolves.toEqual({ removed: [1], kept: [], busy: false });
    expect(fs.existsSync(first.dir)).toBe(false);
  });

  it('keeps a directory that holds an entry this version does not know, and says which', async () => {
    const s = setup();
    const layout = fillGeneration(s, 1);
    const unknown = path.join(layout.dir, 'future-thing');
    touch(unknown);
    const warnings: string[] = [];
    await expect(passOf(s.paths, warnings, { lock: createFakeKernelLock({ inheritable: false }) })).resolves.toEqual({ removed: [], kept: [1], busy: false });
    expect(warnings).toEqual([`leftover cleanup kept ${unknown}: this version does not know the entry`]);
    expect(fs.existsSync(path.join(layout.dir, 'targets', 'apple-1.sock'))).toBe(true);
    expect(fs.existsSync(layout.markers)).toBe(true);
  });

  it('keeps a generation whose jobs/ holds an output file until the file is gone (20.38, 20.64)', async () => {
    const s = setup();
    const layout = fillGeneration(s, 1);
    const jobs = path.join(layout.dir, 'jobs');
    const output = path.join(jobs, 'j.out');
    touch(output, 'bytes');
    const fake = createFakeKernelLock({ inheritable: false });
    const warnings: string[] = [];
    await expect(passOf(s.paths, warnings, { lock: fake })).resolves.toEqual({ removed: [], kept: [1], busy: false });
    expect(warnings).toEqual([`leftover cleanup kept ${jobs}: ENOTEMPTY`]);
    expect(fs.readFileSync(output, 'utf8')).toBe('bytes');
    expect(fs.existsSync(layout.markers)).toBe(true);
    fs.rmSync(output);
    await expect(passOf(s.paths, warnings, { lock: fake })).resolves.toEqual({ removed: [1], kept: [], busy: false });
  });

  it('keeps a generation whose spawn scratch holds an entry no lock proves unused (14.16 S5, 20.40)', async () => {
    const s = setup();
    const layout = fillGeneration(s, 1);
    const entry = path.join(generationSpawnScratch(s.paths, 1), 'call-7');
    fs.mkdirSync(entry, { mode: 0o700 });
    const warnings: string[] = [];
    await expect(passOf(s.paths, warnings)).resolves.toEqual({ removed: [], kept: [1], busy: false });
    expect(warnings).toEqual([`leftover cleanup kept ${entry}: no lock proves it unused`]);
    expect(fs.existsSync(entry)).toBe(true);
    expect(fs.existsSync(layout.markers)).toBe(true);
  });

  it('removes a marker directory that has no generation directory, after the same claims (20.64)', async () => {
    const s = setup();
    const markers = generationMarkerDirectories(s.paths, 7);
    fs.mkdirSync(markers.tools, { recursive: true, mode: 0o700 });
    const log: string[] = [];
    await expect(passOf(s.paths, [], { files: recordingFiles(log), lock: recordingLock(log, createFakeKernelLock({ inheritable: false })) })).resolves.toEqual({ removed: [7], kept: [], busy: false });
    const layout = s.layout(7);
    expect(log.filter((line) => line.startsWith('claim '))).toEqual(
      [s.paths.generationLock, layout.startingLock, layout.locks.supervisor, layout.locks.runtime, layout.locks.gateway].map((lockPath) => `claim ${lockPath}`),
    );
    expect(fs.existsSync(layout.markers)).toBe(false);
    expect(fs.existsSync(layout.dir)).toBe(false);
  });
});

describe('20.65: a pass uses the signal of its asker', () => {
  it('does nothing once the signal is aborted, and an interrupted pass leaves the next one a whole generation', async () => {
    const s = setup();
    const layout = fillGeneration(s, 1);
    const fake = createFakeKernelLock({ inheritable: false });
    const aborted = new AbortController();
    aborted.abort();
    await expect(passOf(s.paths, [], { lock: fake, signal: aborted.signal })).resolves.toEqual({ removed: [], kept: [], busy: false });
    const during = new AbortController();
    const warnings: string[] = [];
    const interrupted = await passOf(s.paths, warnings, {
      lock: fake,
      signal: during.signal,
      reapMarkers: async ({ kind }) => {
        if (kind === 'targets') during.abort();
      },
    });
    expect(interrupted).toEqual({ removed: [], kept: [], busy: false });
    expect(warnings).toEqual([]);
    expect(fake.isHeldBy(layout.locks.supervisor)).toBeUndefined();
    expect(fs.existsSync(layout.markers)).toBe(true);
    await expect(passOf(s.paths, [], { lock: fake })).resolves.toEqual({ removed: [1], kept: [], busy: false });
  });
});

const memoryFiles = (generations: number, paths: MomongaPaths, home: string, onOperation: (line: string) => void): GenerationReaperFiles => {
  const directories = new Set<string>([paths.run, paths.markers.root]);
  const entries = new Set<string>();
  for (let generation = 1; generation <= generations; generation += 1) {
    const layout = generationLayout(home, generation);
    directories.add(layout.dir);
    directories.add(layout.markers);
    entries.add(layout.startRecord);
  }
  const childrenOf = (directory: string): string[] => [...directories, ...entries].filter((entry) => path.dirname(entry) === directory).map((entry) => path.basename(entry));
  const removeUnder = (directory: string): void => {
    for (const set of [directories, entries]) for (const entry of [...set]) if (entry === directory || entry.startsWith(`${directory}${path.sep}`)) set.delete(entry);
  };
  return {
    readdir: async (directory) => {
      onOperation(`readdir ${directory}`);
      if (!directories.has(directory)) throw errno('ENOENT', directory);
      return childrenOf(directory);
    },
    markerFiles: async (directory) => {
      onOperation(`markerFiles ${directory}`);
      return [];
    },
    mkdir: async (directory) => {
      onOperation(`mkdir ${directory}`);
      directories.add(directory);
    },
    unlink: async (file) => {
      onOperation(`unlink ${file}`);
      entries.delete(file);
    },
    rmdir: async (directory) => {
      onOperation(`rmdir ${directory}`);
      if (childrenOf(directory).length > 0) throw errno('ENOTEMPTY', directory);
      directories.delete(directory);
    },
    removeTree: async (directory) => {
      onOperation(`removeTree ${directory}`);
      removeUnder(directory);
    },
  };
};

describe('T-L2-14 (R2.6, 20.5): the pass works in bounded units', () => {
  const operationsFor = async (generations: number, onOperation: (line: string) => void = () => undefined): Promise<number> => {
    const home = path.join(path.sep, 'memory-home');
    const paths = momongaPaths(home, process.platform, {});
    let operations = 0;
    const files = memoryFiles(generations, paths, home, (line) => {
      operations += 1;
      onOperation(line);
    });
    const result = await passOf(paths, [], { files, lock: createFakeKernelLock({ inheritable: false, disk: 'in-memory' }) });
    expect(result.removed).toHaveLength(generations);
    return operations;
  };

  it('spends file operations linear in the number of generations and lists run/ and run/markers once each for the generations', async () => {
    const one = await operationsFor(1);
    const two = await operationsFor(2);
    const lines: string[] = [];
    const fifty = await operationsFor(50, (line) => lines.push(line));
    expect(fifty).toBe(one + 49 * (two - one));
    const paths = momongaPaths(path.join(path.sep, 'memory-home'), process.platform, {});
    expect(lines.filter((line) => line === `readdir ${paths.markers.root}`)).toHaveLength(1);
    expect(lines.filter((line) => line === `readdir ${paths.run}`)).toHaveLength(2);
  });

  it('yields the event loop between two generations', async () => {
    let removedWhenTheLoopRan: number | undefined;
    let removed = 0;
    setImmediate(() => {
      removedWhenTheLoopRan = removed;
    });
    await operationsFor(50, (line) => {
      if (/^rmdir .*g\d+$/.test(line) && !line.includes('spawn')) removed += 1;
    });
    expect(removed).toBe(50);
    expect(removedWhenTheLoopRan).toBeLessThanOrEqual(1);
  });
});

describe('T-L2-19 (R06-71, 20.66): stray temporaries of the atomic writes in run/', () => {
  it('removes a crashed writer\'s temporary under its own claim and keeps one whose writer holds it', async () => {
    const s = setup();
    const lock = testKernelLock();
    const crashed = path.join(s.paths.run, '.current.0a1b2c.tmp');
    const inFlight = path.join(s.paths.run, '.generation.counter.3d4e5f.tmp');
    const abandoned = await lock.claim(crashed);
    const holding = await lock.claim(inFlight);
    if (abandoned.kind !== 'claimed' || holding.kind !== 'claimed') throw new Error('the test could not claim its temporaries');
    touch(crashed, 'left by a crash');
    touch(inFlight, 'in flight');
    abandoned.lock.release();
    try {
      await passOf(s.paths, [], { lock });
      expect(fs.readdirSync(s.paths.run).filter((name) => name.startsWith('.current.'))).toEqual([]);
      expect(fs.readFileSync(inFlight, 'utf8')).toBe('in flight');
    } finally {
      holding.lock.release();
    }
  });
});

type StarterStage = 'idle' | 'counter' | 'directory' | 'locked' | 'waiting';

type WorldStarter = { stage: StarterStage; generation: number };

describe('T-L2-17 (14.7): no interleaving removes something live', () => {
  it('holds NoRemoveLive, LiveStartStepOK and GenBound over 300 seeded interleavings of two starters, supervisors, children and the reaper', async () => {
    const base = makeShortHomeDirectory();
    const random = seededRandom(20_261_110);
    for (let run = 0; run < 300; run += 1) {
      const home = path.join(base, String(run));
      const paths = momongaPaths(home, process.platform, {});
      fs.mkdirSync(paths.markers.root, { recursive: true, mode: 0o700 });
      const fake = createFakeKernelLock({ inheritable: false });
      const layoutOf = (generation: number): GenerationLayout => generationLayout(home, generation);
      const starters: WorldStarter[] = [
        { stage: 'idle', generation: 0 },
        { stage: 'idle', generation: 0 },
      ];
      const supervised = new Set<number>();
      const children = new Set<number>();
      let counter = 0;
      let crashes = 0;
      let exits = 0;
      const external = (lockPath: string): boolean => fake.isHeldBy(lockPath) === 'external';
      const free = (lockPath: string): boolean => fake.isHeldBy(lockPath) === undefined;

      const check = (after: string): void => {
        let dead = 0;
        for (let generation = 1; generation <= counter; generation += 1) {
          const layout = layoutOf(generation);
          const present = fs.existsSync(layout.dir);
          const live = external(layout.locks.supervisor) || external(layout.startingLock) || external(layout.locks.runtime);
          const reserved = starters.some((starter) => starter.generation === generation && (starter.stage === 'directory' || starter.stage === 'locked'));
          if (live || reserved) expect(present, `run ${run}, after ${after}: g${generation} is live and must exist`).toBe(true);
          if (present && !live && !reserved) dead += 1;
        }
        expect(dead, `run ${run}, after ${after}: GenBound`).toBeLessThanOrEqual(exits + crashes);
      };

      const worldActions = (): Array<{ name: string; act(): void }> => {
        const actions: Array<{ name: string; act(): void }> = [];
        for (const starter of starters) {
          const layout = starter.generation === 0 ? undefined : layoutOf(starter.generation);
          if (starter.stage === 'idle' && counter < 3 && free(paths.generationLock)) {
            actions.push({
              name: 'starter-counter',
              act: () => {
                fake.holdExternally(paths.generationLock, 1);
                counter += 1;
                starter.generation = counter;
                starter.stage = 'counter';
              },
            });
          }
          if (starter.stage === 'counter' && layout !== undefined) {
            actions.push({
              name: 'starter-mkdir',
              act: () => {
                fs.mkdirSync(layout.dir, { mode: 0o700 });
                fs.mkdirSync(layout.markers, { mode: 0o700 });
                starter.stage = 'directory';
              },
            });
          }
          if (starter.stage === 'directory' && layout !== undefined) {
            actions.push({
              name: 'starter-lock',
              act: () => {
                expect(fs.existsSync(layout.dir), `run ${run}: LiveStartStepOK g${starter.generation}`).toBe(true);
                fake.holdExternally(layout.startingLock, 1);
                starter.stage = 'locked';
              },
            });
          }
          if (starter.stage === 'locked') {
            actions.push({
              name: 'starter-release',
              act: () => {
                fake.releaseExternally(paths.generationLock);
                starter.stage = 'waiting';
              },
            });
          }
          if (starter.stage !== 'idle' && crashes < 2 && layout !== undefined) {
            actions.push({
              name: 'starter-crash',
              act: () => {
                if (starter.stage !== 'waiting') fake.releaseExternally(paths.generationLock);
                fake.releaseExternally(layout.startingLock);
                if (starter.stage !== 'counter') crashes += 1;
                starter.stage = 'idle';
                starter.generation = 0;
              },
            });
          }
          if (starter.stage === 'waiting' && layout !== undefined && free(layout.locks.supervisor) && free(paths.generationLock)) {
            actions.push({
              name: 'supervisor-claim',
              act: () => {
                fake.holdExternally(layout.locks.supervisor, 2);
                fake.holdExternally(layout.locks.runtime, 3);
                fake.releaseExternally(layout.startingLock);
                supervised.add(starter.generation);
                children.add(starter.generation);
                starter.stage = 'idle';
                starter.generation = 0;
              },
            });
          }
        }
        for (const generation of supervised) {
          actions.push({
            name: 'supervisor-exit',
            act: () => {
              fake.releaseExternally(layoutOf(generation).locks.supervisor);
              supervised.delete(generation);
              exits += 1;
            },
          });
        }
        for (const generation of children) {
          actions.push({
            name: 'child-exit',
            act: () => {
              fake.releaseExternally(layoutOf(generation).locks.runtime);
              children.delete(generation);
            },
          });
        }
        return actions;
      };

      const actOnce = (): string => {
        const actions = worldActions();
        if (actions.length === 0) return 'nothing';
        const action = random.pick(actions);
        action.act();
        check(action.name);
        return action.name;
      };

      const steps = random.int(1, 40);
      for (let step = 0; step < steps; step += 1) {
        if (random.int(0, 3) > 0) {
          actOnce();
          continue;
        }
        const files = recordingFiles([], new Map(), () => {
          if (random.int(0, 2) === 0) actOnce();
        });
        await passOf(paths, [], { files, lock: fake });
        check('a reaper pass');
      }
    }
  });
});

describe('20.61: only a marker kind of momonga-paths.ts is ever handed to the marker reap', () => {
  it('asks for each of the four kinds of the dead generation once, daemons first', async () => {
    const s = setup();
    s.prepare(4);
    const asked: Array<{ generation: number; kind: MarkerKind; directory: string }> = [];
    await passOf(s.paths, [], {
      lock: createFakeKernelLock({ inheritable: false }),
      reapMarkers: async ({ generation, kind, directory }) => {
        asked.push({ generation, kind, directory });
      },
    });
    const markers = generationMarkerDirectories(s.paths, 4);
    expect(asked).toEqual((['daemons', 'mcp', 'tools', 'targets'] as const).map((kind) => ({ generation: 4, kind, directory: markers[kind] })));
  });
});
