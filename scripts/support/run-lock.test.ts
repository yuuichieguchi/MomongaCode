import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, REAP_KILL_GRACE_MS, bsdFileLock, sqliteFileLock } from '@momonga/foundation';
import type { KernelLockMechanism, LockCapability } from '@momonga/foundation';
import { HEAVY_STEPS, LIGHT_HOLDER_STALL_MS, LIGHT_STEPS, RUN_LOCK_DEFAULT_WAIT_SECONDS, RUN_LOCK_EXIT, acquireRunLock, clauseOf, parseWaitSeconds, runLockDirsOf } from './run-lock.ts';
import { createTempRoot, removeTempRoot } from './temp.ts';

const STARTED = '2026-11-10T00:00:00.000Z';
const TO_WAIT = '. To wait, pass --wait <seconds> or set MOMONGA_RUN_LOCK_WAIT_SECONDS.';

type Request = Parameters<typeof acquireRunLock>[0];
type Outcome = Awaited<ReturnType<typeof acquireRunLock>>;
type Acquired = Extract<Outcome, { kind: 'acquired' }>;

const MECHANISMS: Array<[string, KernelLockMechanism]> = [
  ['sqliteFileLock', sqliteFileLock],
  ...(process.platform === 'darwin' ? ([['bsdFileLock', bsdFileLock]] as Array<[string, KernelLockMechanism]>) : []),
];

let root = '';
let dir = '';
let proofDir = '';
const releases: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  root = createTempRoot();
  dir = path.join(root, 'state', 'run-lock');
  proofDir = path.join(root, 'state', 'run-lock-proof');
});

afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release();
  removeTempRoot(root);
});

const entries = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

const descriptionOf = (pid: number, command: string, token: string, runClass: 'heavy' | 'light') =>
  JSON.stringify({ format: 'momonga-run-lock/1', token, class: runClass, pid, startedAt: STARTED, cwd: '/w', command });

describe.each(MECHANISMS)('acquireRunLock with %s', (_name, mechanism) => {
  let progress = 0;
  const request = (over: Partial<Request> = {}): Request => ({
    runClass: 'heavy',
    dir,
    proofDir,
    command: 'cmd1',
    cwd: '/w',
    pid: 111,
    env: {},
    waitSeconds: 0,
    signal: new AbortController().signal,
    say: () => undefined,
    now: () => new Date(STARTED),
    monotonic: () => 0,
    sleep: async () => undefined,
    pollMs: 1000,
    mechanism,
    progressOf: async () => {
      progress += 1;
      return progress;
    },
    endHolder: () => undefined,
    ...over,
  });

  const hold = async (over: Partial<Request> = {}): Promise<Acquired> => {
    const outcome = await acquireRunLock(request(over));
    if (outcome.kind !== 'acquired') throw new Error(`expected acquired, got ${JSON.stringify(outcome)}`);
    releases.push(() => outcome.release());
    return outcome;
  };

  const claimRaw = async (name: string, holder: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const outcome = await mechanism.claim(path.join(dir, name));
    if (outcome.kind !== 'claimed') throw new Error(`${name} was not free`);
    outcome.lock.writeHolder(holder);
    releases.push(() => outcome.lock.dispose());
    return outcome.lock;
  };

  it('TB3 refuses a heavy run while a heavy run holds the lock', async () => {
    await hold();

    const outcome = await acquireRunLock(request({ pid: 999, command: 'cmd9' }));

    expect(outcome).toEqual({ kind: 'refused', message: `run-lock: heavy run refused: held by heavy pid 111 started ${STARTED} in /w: cmd1${TO_WAIT}` });
  });

  it('TB4 acquires a light run while a light run holds the lock', async () => {
    const first = await hold({ runClass: 'light' });
    const second = await hold({ runClass: 'light', pid: 222 });

    expect([first.kind, second.kind]).toEqual(['acquired', 'acquired']);
  });

  it('TB5 refuses a heavy run while a light run holds, and a light run while a heavy run holds', async () => {
    const light = await hold({ runClass: 'light', pid: 222, command: 'cmd2' });

    expect(await acquireRunLock(request())).toEqual({
      kind: 'refused',
      message: `run-lock: heavy run refused: held by light pid 222 started ${STARTED} in /w: cmd2${TO_WAIT}`,
    });

    await light.release();
    await hold({ pid: 333, command: 'cmd3' });

    expect(await acquireRunLock(request({ runClass: 'light' }))).toEqual({
      kind: 'refused',
      message: `run-lock: light run refused: held by heavy pid 333 started ${STARTED} in /w: cmd3${TO_WAIT}`,
    });
  });

  it('TB6 leaves no heavy file after a refused heavy attempt, and a light run then acquires', async () => {
    await hold({ runClass: 'light', pid: 222 });

    expect((await acquireRunLock(request())).kind).toBe('refused');
    expect((await acquireRunLock(request({ runClass: 'light', pid: 444 }))).kind).toBe('acquired');
    expect(entries().filter((name) => name.startsWith('heavy'))).toEqual([]);
  });

  it('TB7 removes every lock and description file on release, and a second release does nothing', async () => {
    const heavy = await hold();
    await heavy.release();
    await heavy.release();
    const light = await hold({ runClass: 'light' });
    await light.release();
    await light.release();

    expect(entries().filter((name) => name.startsWith('heavy') || name.startsWith('light.'))).toEqual([]);
  });

  it('TB8 removes the files of a light holder that died before a heavy run acquires', async () => {
    const hex = 'aaaaaaaaaaaaaaaa';
    const lock = await claimRaw(`light.${hex}`, hex);
    fs.writeFileSync(path.join(dir, `light.${hex}.info`), descriptionOf(222, 'cmd2', hex, 'light'));
    lock.release();

    const outcome = await acquireRunLock(request());
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(outcome.kind).toBe('acquired');
    expect(entries().filter((name) => name.startsWith('light.'))).toEqual([]);
  });

  it('TB9 refuses a heavy run while a live light holder is described, and leaves its file', async () => {
    const hex = 'bbbbbbbbbbbbbbbb';
    await claimRaw(`light.${hex}`, hex);
    fs.writeFileSync(path.join(dir, `light.${hex}.info`), descriptionOf(333, 'cmd3', hex, 'light'));

    expect(await acquireRunLock(request())).toEqual({
      kind: 'refused',
      message: `run-lock: heavy run refused: held by light pid 333 started ${STARTED} in /w: cmd3${TO_WAIT}`,
    });
    expect(entries().filter((name) => name.startsWith(`light.${hex}`) && !name.endsWith('.info')).length).toBeGreaterThan(0);
  });

  it('TB10 waits for a heavy holder that releases during the third sleep and reports the wait', async () => {
    const holder = await hold();
    let clock = 0;
    let sleeps = 0;
    const said: string[] = [];

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        command: 'cmd9',
        waitSeconds: 3,
        say: (line) => said.push(line),
        monotonic: () => clock,
        sleep: async () => {
          sleeps += 1;
          clock += 1000;
          if (sleeps === 3) await holder.release();
        },
      }),
    );
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(outcome.kind).toBe('acquired');
    expect(said).toEqual([`run-lock: heavy run waits up to 3 s for heavy pid 111 started ${STARTED} in /w: cmd1`, 'run-lock: heavy run starts after waiting 3 s']);
  });

  it('a light run whose caller named no limit waits for the heavy holder and is not refused at once', async () => {
    const holder = await hold();
    let clock = 0;
    let sleeps = 0;
    const said: string[] = [];

    const outcome = await acquireRunLock(
      request({
        runClass: 'light',
        pid: 999,
        command: 'cmd9',
        waitSeconds: parseWaitSeconds(undefined, 'env'),
        say: (line) => said.push(line),
        monotonic: () => clock,
        sleep: async () => {
          sleeps += 1;
          clock += 1000;
          if (sleeps === 2) await holder.release();
        },
      }),
    );
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(outcome.kind).toBe('acquired');
    expect(said).toEqual([`run-lock: light run waits up to ${RUN_LOCK_DEFAULT_WAIT_SECONDS} s for heavy pid 111 started ${STARTED} in /w: cmd1`, 'run-lock: light run starts after waiting 2 s']);
    expect(RUN_LOCK_DEFAULT_WAIT_SECONDS).toBeGreaterThan(0);
  });

  it('a heavy run that waits for a light holder keeps a new light run out, and starts when the first light run releases', async () => {
    const first = await hold({ runClass: 'light', pid: 222, command: 'cmd2' });
    let clock = 0;
    let sleeps = 0;
    const lateLights: Outcome[] = [];

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        command: 'cmd9',
        waitSeconds: 10,
        monotonic: () => clock,
        sleep: async () => {
          sleeps += 1;
          clock += 1000;
          if (sleeps === 1) lateLights.push(await acquireRunLock(request({ runClass: 'light', pid: 333, command: 'cmd3' })));
          if (sleeps === 2) await first.release();
        },
      }),
    );
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(lateLights).toEqual([
      { kind: 'refused', message: `run-lock: light run refused: held by waiting heavy pid 999 started ${STARTED} in /w: cmd9${TO_WAIT}` },
    ]);
    expect(outcome.kind).toBe('acquired');
    expect(entries().filter((name) => name.startsWith('waiting.'))).toEqual([]);
  });

  it('a heavy run that waits for a light holder whose processes gain no CPU time for LIGHT_HOLDER_STALL_MS ends that holder and starts', async () => {
    const stalled = await hold({ runClass: 'light', pid: 222, command: 'cmd2' });
    const said: string[] = [];
    const ended: Array<{ pid: number; at: number }> = [];
    let clock = 0;

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        waitSeconds: (LIGHT_HOLDER_STALL_MS / 1000) * 4,
        say: (line) => said.push(line),
        monotonic: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        pollMs: 60_000,
        progressOf: async () => 7,
        endHolder: async (pid, signal) => {
          ended.push({ pid, at: clock });
          expect(signal).toBe('SIGTERM');
          await stalled.release();
        },
      }),
    );
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(outcome.kind).toBe('acquired');
    expect(ended).toEqual([{ pid: 222, at: LIGHT_HOLDER_STALL_MS }]);
    expect(said).toContain(`run-lock: heavy run ends light pid 222 started ${STARTED} in /w: cmd2: its processes used no CPU time for ${LIGHT_HOLDER_STALL_MS / 1000} s`);
  });

  it('a heavy run never ends a light holder whose processes keep gaining CPU time, and gives up at its own limit', async () => {
    await hold({ runClass: 'light', pid: 222, command: 'cmd2' });
    const ended: number[] = [];
    let clock = 0;
    let cpu = 0;

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        waitSeconds: (LIGHT_HOLDER_STALL_MS / 1000) * 3,
        monotonic: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        pollMs: 60_000,
        progressOf: async () => {
          cpu += 0.01;
          return cpu;
        },
        endHolder: (pid) => {
          ended.push(pid);
        },
      }),
    );

    expect(outcome.kind).toBe('waited-out');
    expect(ended).toEqual([]);
  });

  it('a heavy run sends SIGKILL to a stalled light holder that outlives SIGTERM by REAP_KILL_GRACE_MS', async () => {
    const stalled = await hold({ runClass: 'light', pid: 222, command: 'cmd2' });
    const signals: Array<{ signal: string; at: number }> = [];
    const said: string[] = [];
    let clock = 0;

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        waitSeconds: (LIGHT_HOLDER_STALL_MS / 1000) * 4,
        say: (line) => said.push(line),
        monotonic: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        pollMs: 1000,
        progressOf: async () => 7,
        endHolder: async (_pid, signal) => {
          signals.push({ signal, at: clock });
          if (signal === 'SIGKILL') await stalled.release();
        },
      }),
    );
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(outcome.kind).toBe('acquired');
    expect(signals).toEqual([
      { signal: 'SIGTERM', at: LIGHT_HOLDER_STALL_MS },
      { signal: 'SIGKILL', at: LIGHT_HOLDER_STALL_MS + REAP_KILL_GRACE_MS },
    ]);
    expect(said).toContain(`run-lock: heavy run kills light pid 222 started ${STARTED} in /w: cmd2: it outlived SIGTERM by ${REAP_KILL_GRACE_MS / 1000} s`);
  });

  it('reports a failure of the CPU sampler by naming the sampler and the holder', async () => {
    await hold({ runClass: 'light', pid: 222, command: 'cmd2' });

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        waitSeconds: 10,
        progressOf: async () => {
          throw new Error('ps exited 1');
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'unusable', message: `run-lock: cannot read the CPU time of the processes of light pid 222 started ${STARTED} in /w: cmd2: ps exited 1` });
  });

  describe('the queue of waiting runs, in arrival order', () => {
    type Queued = { readonly name: string; outcome: Promise<Outcome>; asleep: boolean; ended: boolean };
    const wakers: Array<() => void> = [];
    const queued: Queued[] = [];

    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 2000; turn += 1) {
        if (queued.every((run) => run.ended || run.asleep)) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error('a queued run neither slept nor ended');
    };

    const arrive = async (name: string, runClass: 'heavy' | 'light'): Promise<Queued> => {
      const run: Queued = { name, outcome: Promise.resolve({ kind: 'aborted' }), asleep: false, ended: false };
      run.outcome = acquireRunLock(
        request({
          runClass,
          pid: 500 + queued.length,
          command: name,
          waitSeconds: 3600,
          sleep: () =>
            new Promise<void>((resolve) => {
              run.asleep = true;
              wakers.push(() => {
                run.asleep = false;
                resolve();
              });
            }),
        }),
      ).then((outcome) => {
        run.ended = true;
        if (outcome.kind === 'acquired') releases.push(() => outcome.release());
        return outcome;
      });
      queued.push(run);
      await settle();
      return run;
    };

    const tick = async (): Promise<void> => {
      for (const wake of wakers.splice(0)) wake();
      await settle();
    };

    const started = (): string[] => queued.filter((run) => run.ended).map((run) => run.name);

    const acquiredOf = async (run: Queued): Promise<Acquired> => {
      const outcome = await run.outcome;
      if (outcome.kind !== 'acquired') throw new Error(`${run.name} did not acquire: ${JSON.stringify(outcome)}`);
      return outcome;
    };

    beforeEach(() => {
      wakers.splice(0);
      queued.splice(0);
    });

    it('starts lights that arrived before a heavy waiter together, while the heavy waiter waits, and keeps a light that arrived after it waiting', async () => {
      const holder = await hold({ pid: 111, command: 'H0' });
      const first = await arrive('L1', 'light');
      const second = await arrive('L2', 'light');
      const heavy = await arrive('H3', 'heavy');
      const late = await arrive('L4', 'light');
      await holder.release();
      await tick();

      expect(started()).toEqual(['L1', 'L2']);
      expect(await acquireRunLock(request({ runClass: 'light', pid: 600, command: 'L5' }))).toEqual({
        kind: 'refused',
        message: `run-lock: light run refused: held by waiting heavy pid 502 started ${STARTED} in /w: H3${TO_WAIT}`,
      });
      await (await acquiredOf(first)).release();
      await tick();
      expect(started()).toEqual(['L1', 'L2']);
      await (await acquiredOf(second)).release();
      await tick();
      expect(started()).toEqual(['L1', 'L2', 'H3']);
      await (await acquiredOf(heavy)).release();
      await tick();
      expect(started()).toEqual(['L1', 'L2', 'H3', 'L4']);
      expect((await late.outcome).kind).toBe('acquired');
    });

    it('starts three heavy runs and the light runs between them in the order they arrived', async () => {
      const holder = await hold({ pid: 111, command: 'H0' });
      const names: Array<[string, 'heavy' | 'light']> = [
        ['L1', 'light'],
        ['H2', 'heavy'],
        ['L3', 'light'],
        ['H4', 'heavy'],
        ['L5', 'light'],
        ['H6', 'heavy'],
      ];
      for (const [name, runClass] of names) await arrive(name, runClass);
      await holder.release();
      const order: string[] = [];
      for (let round = 0; round < names.length; round += 1) {
        await tick();
        const next = queued.filter((run) => run.ended && !order.includes(run.name));
        expect(next.map((run) => run.name)).toHaveLength(1);
        const [run] = next;
        if (run === undefined) throw new Error('no run started');
        order.push(run.name);
        await (await acquiredOf(run)).release();
      }

      expect(order).toEqual(['L1', 'H2', 'L3', 'H4', 'L5', 'H6']);
      expect(entries().filter((name) => name.startsWith('waiting.'))).toEqual([]);
    });

    it('a waiter whose process died keeps no later run out, and whoever meets it removes it', async () => {
      const holder = await hold({ pid: 111, command: 'H0' });
      const hex = 'eeeeeeeeeeeeeeee';
      const lock = await claimRaw(`waiting.0000000000000000.heavy.${hex}`, hex);
      fs.writeFileSync(path.join(dir, `waiting.0000000000000000.heavy.${hex}.info`), descriptionOf(222, 'dead', hex, 'heavy'));
      lock.release();
      await arrive('L1', 'light');
      await holder.release();
      await tick();

      expect(started()).toEqual(['L1']);
      expect(entries().filter((name) => name.includes(hex))).toEqual([]);
    });
  });

  it('a heavy waiter whose process died does not keep a light run out, and its files are removed', async () => {
    const hex = 'dddddddddddddddd';
    const lock = await claimRaw(`waiting.0000000000000001.heavy.${hex}`, hex);
    fs.writeFileSync(path.join(dir, `waiting.0000000000000001.heavy.${hex}.info`), descriptionOf(222, 'cmd2', hex, 'heavy'));
    lock.release();

    const outcome = await acquireRunLock(request({ runClass: 'light' }));
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(outcome.kind).toBe('acquired');
    expect(entries().filter((name) => name.startsWith('waiting.'))).toEqual([]);
  });

  it('TB11 gives up when the limit passes with the holder still there, after exactly two sleeps', async () => {
    await hold();
    let clock = 0;
    let sleeps = 0;

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        waitSeconds: 2,
        monotonic: () => clock,
        sleep: async () => {
          sleeps += 1;
          clock += 1000;
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'waited-out', message: `run-lock: heavy run gave up after 2 s: still held by heavy pid 111 started ${STARTED} in /w: cmd1` });
    expect(sleeps).toBe(2);
  });

  it('TB12 ends as aborted when the signal is aborted during a sleep, holding no heavy lock', async () => {
    await hold({ runClass: 'light', pid: 222 });
    const controller = new AbortController();
    let clock = 0;

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        waitSeconds: 10,
        signal: controller.signal,
        monotonic: () => clock,
        sleep: (_ms, signal) => {
          clock += 1000;
          controller.abort();
          return Promise.reject(signal.reason);
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(await mechanism.isHeld(path.join(dir, 'heavy'))).toBe(false);
  });

  it('a heavy run that waits for two light holders keeps a third light run out, and starts when both release', async () => {
    const first = await hold({ runClass: 'light', pid: 222, command: 'cmd2' });
    const second = await hold({ runClass: 'light', pid: 333, command: 'cmd3' });
    let clock = 0;
    let sleeps = 0;
    const lateLights: Outcome[] = [];

    const outcome = await acquireRunLock(
      request({
        pid: 999,
        command: 'cmd9',
        waitSeconds: 10,
        monotonic: () => clock,
        sleep: async () => {
          sleeps += 1;
          clock += 1000;
          if (sleeps === 1) lateLights.push(await acquireRunLock(request({ runClass: 'light', pid: 444, command: 'cmd4' })));
          if (sleeps === 2) await first.release();
          if (sleeps === 3) await second.release();
        },
      }),
    );
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(lateLights).toEqual([
      { kind: 'refused', message: `run-lock: light run refused: held by waiting heavy pid 999 started ${STARTED} in /w: cmd9${TO_WAIT}` },
    ]);
    expect(outcome.kind).toBe('acquired');
  });

  const tokenRows: Array<[string, () => Promise<{ env: Record<string, string>; runClass: 'heavy' | 'light'; old?: string }>, string]> = [
    ['a live heavy token and a light request', async () => ({ env: { MOMONGA_RUN_LOCK: (await hold()).token }, runClass: 'light' }), 'inherited'],
    ['a live heavy token and a heavy request', async () => ({ env: { MOMONGA_RUN_LOCK: (await hold()).token }, runClass: 'heavy' }), 'inherited'],
    ['a live light token and a light request', async () => ({ env: { MOMONGA_RUN_LOCK: (await hold({ runClass: 'light' })).token }, runClass: 'light' }), 'inherited'],
    ['a live light token and a heavy request', async () => ({ env: { MOMONGA_RUN_LOCK: (await hold({ runClass: 'light' })).token }, runClass: 'heavy' }), 'nested'],
    [
      'a token whose lock is not held',
      async () => {
        const gone = await hold();
        await gone.release();
        return { env: { MOMONGA_RUN_LOCK: gone.token }, runClass: 'heavy', old: gone.token };
      },
      'acquired',
    ],
    ['a malformed token', async () => ({ env: { MOMONGA_RUN_LOCK: 'heavy.xyz' }, runClass: 'heavy', old: 'heavy.xyz' }), 'acquired'],
  ];

  it.each(tokenRows)('TB13 with %s', async (_case, arrange, expected) => {
    const { env, runClass, old } = await arrange();

    const outcome = await acquireRunLock(request({ env, runClass, pid: 999 }));
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    if (expected === 'nested') expect(outcome).toEqual({ kind: 'refused', message: 'run-lock: a heavy run cannot start inside a light run' });
    else if (expected === 'inherited') expect(outcome).toEqual({ kind: 'inherited' });
    else {
      expect(outcome.kind).toBe('acquired');
      expect(outcome.kind === 'acquired' ? outcome.token : '').toMatch(/^heavy\.[0-9a-f]{16}$/);
      expect(outcome.kind === 'acquired' ? outcome.token : old).not.toBe(old);
    }
  });

  it('TB14 writes heavy.info whole, with exactly the stated keys and the command cut at 300 characters', async () => {
    const info = path.join(dir, 'heavy.info');
    const seen: string[] = [];
    let done = false;
    const reads = (async () => {
      let count = 0;
      while (count < 200 || !done) {
        const batch = await Promise.all(
          Array.from({ length: 20 }, () =>
            fs.promises.readFile(info, 'utf8').then(
              (text) => text,
              (error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
                throw error;
              },
            ),
          ),
        );
        count += batch.length;
        for (const text of batch) if (text !== undefined) seen.push(text);
        if (count >= 200 && done) break;
      }
    })();
    const outcome = await acquireRunLock(request({ command: 'x'.repeat(400) }));
    done = true;
    await reads;
    if (outcome.kind !== 'acquired') throw new Error(`expected acquired, got ${outcome.kind}`);
    releases.push(() => outcome.release());

    for (const text of seen) expect(() => JSON.parse(text)).not.toThrow();
    const description = JSON.parse(fs.readFileSync(info, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(description).sort()).toEqual(['class', 'command', 'cwd', 'format', 'pid', 'startedAt', 'token']);
    expect(description).toEqual({
      format: 'momonga-run-lock/1',
      token: await mechanism.readHolder(path.join(dir, 'heavy')),
      class: 'heavy',
      pid: 111,
      startedAt: STARTED,
      cwd: '/w',
      command: 'x'.repeat(300),
    });
    expect(outcome.token).toBe(`heavy.${String(description['token'])}`);
  });

  it.each([
    ['a dir under a regular file', 'file'],
    ['a mechanism whose claim throws EACCES', 'eacces'],
  ])('TB15 reports the lock as unusable for %s', async (_case, kind) => {
    if (kind === 'file') {
      const blocker = path.join(root, 'blocker');
      fs.writeFileSync(blocker, '');
      const blocked = path.join(blocker, 'run-lock');

      expect(await acquireRunLock(request({ dir: blocked, proofDir: path.join(blocker, 'run-lock-proof') }))).toEqual({
        kind: 'unusable',
        message: `run-lock: cannot use ${blocked}: ENOTDIR`,
      });
    } else {
      const refusing: KernelLockMechanism = {
        ...mechanism,
        claim: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
      };

      expect(await acquireRunLock(request({ mechanism: refusing }))).toEqual({ kind: 'unusable', message: `run-lock: cannot use ${dir}: EACCES` });
    }
  });

  it.each([
    ['without a description file', undefined],
    ['whose description names another token', 'ffffffffffffffff'],
  ])('TB16 shows a held heavy %s as heavy (no description)', async (_case, otherToken) => {
    await claimRaw('heavy', '1111111111111111');
    if (otherToken !== undefined) fs.writeFileSync(path.join(dir, 'heavy.info'), descriptionOf(111, 'cmd1', otherToken, 'heavy'));

    expect(await acquireRunLock(request({ runClass: 'light' }))).toEqual({
      kind: 'refused',
      message: `run-lock: light run refused: held by heavy (no description)${TO_WAIT}`,
    });
  });

  it('TB17 names every light holder in one refusal, ordered by file name', async () => {
    const first = await hold({ runClass: 'light', pid: 201, command: 'a' });
    const second = await hold({ runClass: 'light', pid: 202, command: 'b' });
    const clauses = [
      { name: first.token, clause: `light pid 201 started ${STARTED} in /w: a` },
      { name: second.token, clause: `light pid 202 started ${STARTED} in /w: b` },
    ]
      .sort((left, right) => (left.name < right.name ? -1 : 1))
      .map((entry) => entry.clause);

    expect(await acquireRunLock(request())).toEqual({ kind: 'refused', message: `run-lock: heavy run refused: held by ${clauses.join('; ')}${TO_WAIT}` });
  });

  type LockOperation = { operation: 'claim' | 'isHeld'; name: string; describedBefore: boolean };

  const recording = (described: string): { mechanism: KernelLockMechanism; operations: LockOperation[] } => {
    const operations: LockOperation[] = [];
    const note = (operation: LockOperation['operation'], lockPath: string): void => {
      operations.push({ operation, name: path.basename(lockPath), describedBefore: fs.existsSync(path.join(dir, described)) });
    };
    return {
      operations,
      mechanism: {
        ...mechanism,
        claim: (lockPath) => {
          note('claim', lockPath);
          return mechanism.claim(lockPath);
        },
        isHeld: (lockPath) => {
          note('isHeld', lockPath);
          return mechanism.isHeld(lockPath);
        },
      },
    };
  };

  const LIGHT_LOCK_NAME = /^light\.[0-9a-f]{16}$/;

  const withoutRepeats = (steps: readonly string[]): string[] => steps.filter((step, index) => step !== steps[index - 1]);

  it('R3 claims the own name of a light run before it looks at the heavy lock, in the order of LIGHT_STEPS', async () => {
    const recorder = recording('heavy.info');

    const outcome = await hold({ runClass: 'light', mechanism: recorder.mechanism });

    const ownName = outcome.token;
    const observed = recorder.operations.map(({ operation, name }) => {
      if (operation === 'claim' && name === ownName) return 'claimOwn';
      if (operation === 'isHeld' && name === 'heavy') return 'checkHeavy';
      return `${operation} ${name}`;
    });
    expect(LIGHT_LOCK_NAME.test(ownName)).toBe(true);
    expect(observed).toEqual([...LIGHT_STEPS]);
  });

  it('R3 claims the heavy lock before any operation on a light name and decides after the scan, in the order of HEAVY_STEPS', async () => {
    const hex = 'cccccccccccccccc';
    const leftover = await claimRaw(`light.${hex}`, hex);
    leftover.release();
    const recorder = recording('heavy.info');

    await hold({ mechanism: recorder.mechanism });

    const scanned = recorder.operations.map(({ operation, name }) => {
      if (operation === 'claim' && name === 'heavy') return 'claimHeavy';
      if (name === `light.${hex}`) return 'scanOne';
      return `${operation} ${name}`;
    });
    const decidedAfterTheScan = recorder.operations.every((operation) => !operation.describedBefore) && fs.existsSync(path.join(dir, 'heavy.info'));
    expect(recorder.operations.filter((operation) => operation.name === `light.${hex}`).map((operation) => operation.operation)).toEqual(['isHeld', 'claim']);
    expect([...withoutRepeats(scanned), ...(decidedAfterTheScan ? ['decide'] : [])]).toEqual([...HEAVY_STEPS]);
  });
});

describe('acquireRunLock chooses its mechanism by capability', () => {
  const request = (capability: LockCapability): Request => ({
    runClass: 'heavy',
    dir,
    proofDir,
    command: 'cmd1',
    cwd: '/w',
    pid: 111,
    env: {},
    waitSeconds: 0,
    signal: new AbortController().signal,
    say: () => undefined,
    now: () => new Date(STARTED),
    capability: { of: async () => capability },
  });

  const rows: Array<[LockCapability, string]> = [
    ...(process.platform === 'darwin' ? ([['proved', 'file-lock']] as Array<[LockCapability, string]>) : []),
    ['unenforced', 'sqlite-lock'],
  ];

  it.each(rows)('TB18 uses the mechanism of capability %s', async (capability, expected) => {
    const outcome = await acquireRunLock(request(capability));
    if (outcome.kind === 'acquired') releases.push(() => outcome.release());

    expect(outcome.kind === 'acquired' ? outcome.mechanism : outcome.kind).toBe(expected);
  });

  it('TB15 TB18 refuses the run when the capability could not be measured', async () => {
    expect(await acquireRunLock(request('unmeasured'))).toEqual({
      kind: 'unusable',
      message: `run-lock: cannot use ${dir}: the lock capability of ${dir} could not be measured`,
    });
  });
});

describe('parseWaitSeconds', () => {
  it.each([
    [undefined, 'env', RUN_LOCK_DEFAULT_WAIT_SECONDS],
    ['0', 'env', 0],
    ['30', 'env', 30],
    ['', 'env', RUN_LOCK_DEFAULT_WAIT_SECONDS],
  ] as const)('TB19 reads %j from %s as %d', (text, source, expected) => {
    expect(parseWaitSeconds(text, source)).toBe(expected);
  });

  it.each([
    ['-1', 'option', 'run-lock: --wait must be a whole number of seconds, got "-1"'],
    ['1.5', 'option', 'run-lock: --wait must be a whole number of seconds, got "1.5"'],
    ['abc', 'env', 'run-lock: MOMONGA_RUN_LOCK_WAIT_SECONDS must be a whole number of seconds, got "abc"'],
    ['', 'option', 'run-lock: --wait must be a whole number of seconds, got ""'],
  ] as const)('TB19 refuses %j from %s', (text, source, message) => {
    expect(() => parseWaitSeconds(text, source)).toThrow(new Error(message));
  });
});

describe('clauseOf', () => {
  const description = { pid: 111, startedAt: '2026-11-10T00:00:00.000Z', cwd: '/w', command: 'cmd1' };

  it.each([
    ['heavy', description, 'heavy pid 111 started 2026-11-10T00:00:00.000Z in /w: cmd1'],
    ['light', undefined, 'light (no description)'],
    ['heavy', undefined, 'heavy (no description)'],
    ['light', { ...description, cwd: '/a b', command: 'x: y  z' }, 'light pid 111 started 2026-11-10T00:00:00.000Z in /a b: x: y  z'],
  ] as const)('TB20 describes a %s holder with %j as %s', (runClass, holder, expected) => {
    expect(clauseOf(runClass, holder)).toBe(expected);
  });
});

describe('the directories of the run lock', () => {
  it('R7 are named by one function of the state directory', () => {
    expect(runLockDirsOf('/state/momonga-dev')).toEqual({ dir: path.join('/state/momonga-dev', 'run-lock'), proofDir: path.join('/state/momonga-dev', 'run-lock-proof') });
  });

  it('R7 are named as text in scripts/support/run-lock.ts and in no other source of scripts, test or e2e', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const DIRECTORY_NAME = /['"`]run-lock(?:-proof)?['"`]/;
    const sources = ['scripts', 'test', 'e2e'].flatMap((top) =>
      (fs.readdirSync(path.join(repoRoot, top), { recursive: true }) as string[])
        .filter((name) => /\.(?:ts|tsx|mjs|sh)$/.test(name) && !/\.test\.tsx?$/.test(name))
        .map((name) => path.join(top, name).split(path.sep).join('/')),
    );
    const naming = sources.filter((file) => DIRECTORY_NAME.test(fs.readFileSync(path.join(repoRoot, file), 'utf8'))).sort();
    expect(naming).toEqual(['scripts/support/run-lock.ts']);
  });
});

describe('the exit codes of the run lock', () => {
  const TLC_EXIT_STATUSES: readonly number[] = [0, 10, 11, 12, 13, 14, 75, 76, 77, 150, 151, 152, 153, 255];
  const TLC_SCRIPT_EXITS: readonly number[] = [2, 3, 4, 5];
  const SHELL_EXITS: readonly number[] = [1, 2, 126, 127];
  const SIGNAL_EXIT_BASE = 128;
  const ownCodes = [RUN_LOCK_EXIT.cpuBudget, RUN_LOCK_EXIT.starterGone];

  it('end a breached run with codes no product, TLC, tlc.sh or shell code uses', () => {
    const taken = new Set([...Object.values(EXIT_CODES).map((entry) => entry.code), ...TLC_EXIT_STATUSES, ...TLC_SCRIPT_EXITS, ...SHELL_EXITS]);
    expect(ownCodes.filter((code) => taken.has(code) || code >= SIGNAL_EXIT_BASE)).toEqual([]);
  });

  it('give each outcome a code of its own', () => {
    const codes = Object.values(RUN_LOCK_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
