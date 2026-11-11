import { TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { GroupContainmentError, createKeptGroupControl, createProcessGroupPort, groupTerminationBoundMs, nodeCommandRunner } from '@momonga/foundation';
import type { ProcessGroupPort } from '@momonga/foundation';
import { launch } from '../src/process.ts';
import type { LaunchOptions } from '../src/process.ts';
import { answeringMembers, fakeKeeperHost, settle } from '../../foundation/test/support/fake-keeper.ts';
import type { FakeKeeper, FakeKeeperHost } from '../../foundation/test/support/fake-keeper.ts';
import { virtualTiming, settlementOf, driveUntil } from '../../foundation/test/support/probe-fakes.ts';
import type { VirtualTiming } from '../../foundation/test/support/probe-fakes.ts';

const KEEPER_PID = 9_999_991;
const COMMAND_PID = 9_999_992;
const KILL_GRACE_MS = 300;
const KEEPER_TERMINATED = 0x4d4b0009;

type Spawned = { file: string; args: readonly string[]; options: { detached?: boolean; windowsHide?: boolean; stdio?: readonly unknown[]; cwd?: string; env?: Record<string, string> } };

type World = {
  fake: FakeKeeperHost;
  port: ProcessGroupPort;
  timing: VirtualTiming;
  spawned: Spawned[];
  controller: AbortController;
  afterExit: number;
  start(extra?: Partial<LaunchOptions>): ReturnType<typeof launch>;
};

const worldOf = (script: (keeper: FakeKeeper, index: number) => void): World => {
  const fake = fakeKeeperHost(script);
  const port = createProcessGroupPort('win32', { run: nodeCommandRunner, env: {}, kept: createKeptGroupControl(fake.host) });
  const timing = virtualTiming();
  const spawned: Spawned[] = [];
  const controller = new AbortController();
  const world: World = {
    fake,
    port,
    timing,
    spawned,
    controller,
    afterExit: 0,
    start: (extra = {}) =>
      launch({
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/c', 'echo a b'],
        cwd: 'C:\\work',
        env: { SystemRoot: 'C:\\Windows' },
        signal: controller.signal,
        protection: TEST_CHILD_UNPROTECTED,
        killGraceMs: KILL_GRACE_MS,
        afterExit: () => void (world.afterExit += 1),
        spawnProcess: ((file: string, args: readonly string[], options: Spawned['options']) => {
          spawned.push({ file, args, options });
          fake.start(file, args);
          return Object.assign(new EventEmitter(), { pid: KEEPER_PID, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
        }) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
        groupPort: port,
        timing,
        ...extra,
      }),
  };
  return world;
};

const running =
  (members: () => readonly number[]) =>
  (keeper: FakeKeeper): void => {
    answeringMembers(members)(keeper);
    keeper.say(`started ${COMMAND_PID}\n`);
  };

describe('on a port whose identity is a job the launch goes through the keeper', () => {
  it('starts the keeper, not the command: the command and its arguments after --, the marker by its path, the standard streams of the keeper for the command', async () => {
    const world = worldOf(running(() => [COMMAND_PID]));
    const launched = world.start({ markerFile: 'C:\\m\\marker' });
    launched.exited.catch(() => undefined);
    expect(launched.pid).toBe(KEEPER_PID);
    expect(launched.pgid).toBe(KEEPER_PID);
    expect(world.spawned).toHaveLength(1);
    const { file, args, options } = world.spawned[0] as Spawned;
    expect(file).toBe('C:\\cache\\momonga-keeper.exe');
    expect(args[0]).toBe('launch');
    expect(args[4]).toBe(Buffer.from('C:\\m\\marker', 'utf8').toString('hex'));
    expect(args.slice(5)).toEqual(['-', '--', 'C:\\Windows\\System32\\cmd.exe', '/c', 'echo a b']);
    expect(options).toMatchObject({ cwd: 'C:\\work', env: { SystemRoot: 'C:\\Windows' }, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(world.port.names?.nameOf(KEEPER_PID)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('resolves with the exit code the keeper reports for the command, after the group is confirmed gone', async () => {
    let members = [COMMAND_PID];
    const world = worldOf(running(() => members));
    const launched = world.start();
    await settle();
    members = [];
    world.fake.keepers[0]?.say('exit 3\n');
    expect(await launched.exited).toEqual({ code: 3, signal: null });
    expect(world.afterExit).toBe(1);
  });

  it('stops what outlived the command with the one signal of the port', async () => {
    let members = [COMMAND_PID, 77];
    const world = worldOf((keeper) => {
      running(() => members)(keeper);
      const answer = keeper.onRequest;
      keeper.onRequest = (line) => {
        if (line === 'terminate') {
          members = [];
          keeper.say('empty\n');
        } else answer(line);
      };
    });
    const launched = world.start();
    await settle();
    members = [77];
    world.fake.keepers[0]?.say('exit 0\n');
    expect(await launched.exited).toEqual({ code: 0, signal: null });
    expect(world.fake.keepers[0]?.written.filter((line) => line === 'terminate\n')).toHaveLength(1);
  });

  it('reports a command whose keeper was lost without an exit word as killed', async () => {
    const world = worldOf((keeper, index) => {
      if (index === 0) running(() => [COMMAND_PID])(keeper);
      else keeper.say('failed job-absent 2\n');
    });
    const launched = world.start();
    await settle();
    world.fake.keepers[0]?.hangUp();
    expect(await launched.exited).toEqual({ code: null, signal: 'SIGKILL' });
  });
});

describe('T-JO-7 at the product level on a fake keeper', () => {
  it('reports containment-unavailable as the failure of the launch, and the cleanup after the exit still runs', async () => {
    const world = worldOf((keeper) => keeper.say('failed containment-unavailable 5\n'));
    const launched = world.start();
    const failure = await launched.exited.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GroupContainmentError);
    expect((failure as Error).message).toContain('containment-unavailable');
    expect(world.afterExit).toBe(1);
    expect(world.fake.keepers).toHaveLength(1);
  });
});

describe('an abort on a port with one signal', () => {
  it('sends the one terminate, sends nothing after the grace, and resolves as stopped by the abort', async () => {
    let members = [COMMAND_PID];
    const world = worldOf((keeper) => {
      running(() => members)(keeper);
      const answer = keeper.onRequest;
      keeper.onRequest = (line) => {
        if (line !== 'terminate') answer(line);
      };
    });
    const launched = world.start();
    await settle();
    world.controller.abort();
    await driveUntil(world.timing, () => world.timing.pending().length > 0, 0, 'the kill grace to be armed');
    await world.timing.advanceAsync(KILL_GRACE_MS + 1);
    const keeper = world.fake.keepers[0] as FakeKeeper;
    expect(keeper.written.filter((line) => line === 'terminate\n')).toHaveLength(1);
    members = [];
    keeper.say(`exit ${KEEPER_TERMINATED}\nempty\n`);
    expect(await launched.exited).toEqual({ code: KEEPER_TERMINATED, signal: null, killedBy: 'abort' });
  });

  it('rejects at the stop bound of the launch, in virtual time, when the pipe never answers', async () => {
    const world = worldOf((keeper) => keeper.say(`started ${COMMAND_PID}\n`));
    const launched = world.start();
    const exited = launched.exited;
    const stopped = settlementOf(exited);
    await settle();
    world.controller.abort();
    const bound = groupTerminationBoundMs(KILL_GRACE_MS);
    await driveUntil(world.timing, () => world.timing.pending().some((timer) => timer.dueAt === bound), bound, 'the stop bound to be armed');
    await world.timing.advanceAsync(bound - 1);
    expect(stopped.current().state).toBe('pending');
    await world.timing.advanceAsync(1);
    await expect(exited).rejects.toBeDefined();
  });
});
