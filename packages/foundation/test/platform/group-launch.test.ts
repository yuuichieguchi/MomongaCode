import { createTempDir, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupContainmentError, KeeperProtocolError, createKeptGroupControl, createPosixGroupPort, createProcessGroupPort, launchApart, launchGroupLeader, nodeCommandRunner, systemWaitTiming } from '../../src/index.ts';
import type { ProcessGroupPort } from '../../src/index.ts';
import type { GroupLaunchRequest } from '../../src/platform/group-launch.ts';
import { answeringMembers, fakeKeeperHost, settle } from '../support/fake-keeper.ts';

const KEEPER_PID = 9_999_981;
const COMMAND_PID = 9_999_982;
const LEADER_PID = 9_999_983;

type Options = { detached?: boolean; windowsHide?: boolean; stdio?: readonly unknown[]; cwd?: string; env?: Record<string, string> };
type Spawned = { file: string; args: readonly string[]; options: Options; child: EventEmitter };

type SpawnProcess = NonNullable<GroupLaunchRequest['spawnProcess']>;

const recordingSpawn = (pid: number | undefined, seen: Spawned[], started: (file: string, args: readonly string[]) => void = () => undefined): SpawnProcess =>
  ((file: string, args: readonly string[], options: Options) => {
    const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null });
    seen.push({ file, args, options, child });
    started(file, args);
    return child;
  }) as unknown as SpawnProcess;

const posixPort = (): ProcessGroupPort => createPosixGroupPort({ kill: () => undefined, reading: { states: async () => [], successMeansRunnable: true } });

const roots: string[] = [];

const markerIn = (): string => {
  const root = createTempDir();
  roots.push(root);
  const marker = path.join(root, 'marker');
  fs.writeFileSync(marker, '');
  return marker;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('on a port whose groups are process groups the launch is a detached spawn', () => {
  it('starts the command itself as the leader of a new group, and the group is its pid', async () => {
    const seen: Spawned[] = [];
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: '/bin/echo', args: ['a'], cwd: '/work', env: { A: '1' }, stdio: ['ignore', 'pipe', 'pipe'], port: posixPort(), spawnProcess: recordingSpawn(LEADER_PID, seen) });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.file).toBe('/bin/echo');
    expect(seen[0]?.args).toEqual(['a']);
    expect(seen[0]?.options).toEqual({ cwd: '/work', env: { A: '1' }, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(launched.pgid).toBe(LEADER_PID);
    expect(launched.child).toBe(seen[0]?.child);
  });

  it('leaves the working directory and the environment to the host when none is given', async () => {
    const seen: Spawned[] = [];
    await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: '/bin/echo', args: [], stdio: ['ignore', 'ignore', 'ignore'], port: posixPort(), spawnProcess: recordingSpawn(LEADER_PID, seen) });
    expect(seen[0]?.options).toEqual({ detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  });

  it('opens the marker read-only for the command at its slot and closes its own descriptor after the start', async () => {
    const marker = markerIn();
    const seen: Spawned[] = [];
    await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: '/bin/echo', args: [], stdio: ['ignore', 'pipe', 'pipe'], marker: { slot: 3, file: marker }, port: posixPort(), spawnProcess: recordingSpawn(LEADER_PID, seen) });
    const fd = seen[0]?.options.stdio?.[3];
    expect(typeof fd).toBe('number');
    expect(() => fs.fstatSync(fd as number)).toThrow(/EBADF/);
  });

  it('passes a descriptor the caller opened at the slot and leaves it open', async () => {
    const marker = markerIn();
    const given = fs.openSync(marker, 'r');
    try {
      const seen: Spawned[] = [];
      await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: '/bin/echo', args: [], stdio: ['ignore', 'pipe', 'pipe', 'pipe'], marker: { slot: 4, file: marker, descriptor: given }, port: posixPort(), spawnProcess: recordingSpawn(LEADER_PID, seen) });
      expect(seen[0]?.options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe', given]);
      expect(fs.fstatSync(given).isFile()).toBe(true);
    } finally {
      fs.closeSync(given);
    }
  });

  it('closes the descriptor it opened when the start throws', async () => {
    const marker = markerIn();
    let fd: unknown;
    const failing = ((_file: string, _args: readonly string[], options: Options) => {
      fd = options.stdio?.[3];
      throw new Error('spawn failed: injected');
    }) as unknown as SpawnProcess;
    await expect(launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: '/bin/echo', args: [], stdio: ['ignore', 'pipe', 'pipe'], marker: { slot: 3, file: marker }, port: posixPort(), spawnProcess: failing })).rejects.toThrow('spawn failed: injected');
    expect(() => fs.fstatSync(fd as number)).toThrow(/EBADF/);
  });

  it('tells the exit of the leader with its code and signal', async () => {
    const seen: Spawned[] = [];
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: '/bin/echo', args: [], stdio: ['ignore', 'pipe', 'pipe'], port: posixPort(), spawnProcess: recordingSpawn(LEADER_PID, seen) });
    const exits: unknown[] = [];
    launched.onExit((exit) => exits.push(exit), () => exits.push('failed'));
    seen[0]?.child.emit('exit', null, 'SIGTERM');
    expect(exits).toEqual([{ code: null, signal: 'SIGTERM' }]);
  });

  it('starts a real command in a group of its own', async () => {
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: process.execPath, args: ['-e', 'process.exit(7)'], stdio: ['ignore', 'ignore', 'ignore'] });
    const exit = await new Promise((resolve, reject) => launched.onExit(resolve, reject));
    expect(launched.pgid).toBe(launched.child.pid);
    expect(exit).toEqual({ code: 7, signal: null });
  });
});

describe('a launch begun outside any promise', () => {
  it('delivers the spawn error of a missing program to a listener attached after the launch is awaited', async () => {
    const error = await new Promise<unknown>((resolve) => {
      systemWaitTiming.setTimeout(() => {
        void launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: '/nonexistent/momonga-missing-program', args: [], stdio: ['ignore', 'ignore', 'ignore'], port: posixPort() }).then((launched) => {
          launched.child.once('error', resolve);
        });
      }, 0);
    });
    expect(error).toMatchObject({ code: 'ENOENT' });
  });
});

describe('on a port whose identity is a job the launch goes through the keeper', () => {
  const world = (script: Parameters<typeof fakeKeeperHost>[0]) => {
    const fake = fakeKeeperHost(script);
    const port = createProcessGroupPort('win32', { run: nodeCommandRunner, env: {}, kept: createKeptGroupControl(fake.host) });
    const seen: Spawned[] = [];
    return { fake, port, seen, spawnProcess: recordingSpawn(KEEPER_PID, seen, (file, args) => void fake.start(file, args)) };
  };

  const running = (keeper: Parameters<NonNullable<Parameters<typeof fakeKeeperHost>[0]>>[0]): void => {
    answeringMembers(() => [COMMAND_PID])(keeper);
    keeper.say(`started ${COMMAND_PID}\n`);
  };

  it('starts the keeper with the command after --, the marker by its path, and the marker slot of the caller ignored', async () => {
    const { port, seen, spawnProcess } = world(running);
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED,
      file: 'C:\\node.exe',
      args: ['server.js'],
      cwd: 'C:\\work',
      env: { SystemRoot: 'C:\\Windows' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 17],
      marker: { slot: 4, file: 'C:\\m\\marker', descriptor: 17 },
      port,
      spawnProcess,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.file).toBe('C:\\cache\\momonga-keeper.exe');
    expect(seen[0]?.args[0]).toBe('launch');
    expect(seen[0]?.args[4]).toBe(Buffer.from('C:\\m\\marker', 'utf8').toString('hex'));
    expect(seen[0]?.args.slice(5)).toEqual(['3', '--', 'C:\\node.exe', 'server.js']);
    expect(seen[0]?.options).toEqual({ cwd: 'C:\\work', env: { SystemRoot: 'C:\\Windows' }, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ignore'] });
    expect(launched.pgid).toBe(KEEPER_PID);
    expect(port.names?.nameOf(KEEPER_PID)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('names to the keeper every slot after the standard three that carries a descriptor, and tells the exit once the keeper says it passed them', async () => {
    const { fake, port, seen, spawnProcess } = world((keeper) => {
      answeringMembers(() => [COMMAND_PID])(keeper);
      keeper.say(`started ${COMMAND_PID} 3 5\n`);
    });
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: 'C:\\node.exe', args: [], stdio: ['ignore', 'pipe', 'pipe', 'pipe', 17, 21], marker: { slot: 4, file: 'C:\\m\\marker', descriptor: 17 }, port, spawnProcess });
    expect(seen[0]?.args.slice(5, 7)).toEqual(['3,5', '--']);
    expect(seen[0]?.options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe', 'ignore', 21]);
    const exits: unknown[] = [];
    launched.onExit((exit) => exits.push(exit), () => exits.push('failed'));
    await settle();
    fake.keepers[0]?.say('exit 0\n');
    await settle();
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });

  it('names no descriptor when the command gets only the standard three', async () => {
    const { port, seen, spawnProcess } = world(running);
    await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: 'C:\\node.exe', args: [], stdio: ['ignore', 'pipe', 'pipe', 'ignore'], port, spawnProcess });
    expect(seen[0]?.args.slice(5, 7)).toEqual(['-', '--']);
  });

  it('tells a launch whose keeper dropped a named descriptor as a failure, never as a started command', async () => {
    const { fake, port, spawnProcess } = world((keeper) => keeper.say(`started ${COMMAND_PID} 5\n`));
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: 'C:\\node.exe', args: [], stdio: ['ignore', 'pipe', 'pipe', 'pipe', 17, 21], marker: { slot: 4, file: 'C:\\m\\marker', descriptor: 17 }, port, spawnProcess });
    const outcomes: unknown[] = [];
    launched.onExit(() => outcomes.push('exit'), (error) => outcomes.push(error));
    await settle();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toBeInstanceOf(KeeperProtocolError);
    expect(fake.keepers[0]?.closedByClient()).toBe(true);
  });

  it('opens no descriptor of the marker and adds no slot for it', async () => {
    const { port, seen, spawnProcess } = world(running);
    await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: 'C:\\node.exe', args: [], stdio: ['ignore', 'pipe', 'pipe'], marker: { slot: 3, file: 'C:\\absent\\marker' }, port, spawnProcess });
    expect(seen[0]?.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('refuses a marker given only as a descriptor', async () => {
    const { port, spawnProcess } = world(running);
    await expect(launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: 'C:\\node.exe', args: [], stdio: ['ignore', 'pipe', 'pipe'], marker: { slot: 3, descriptor: 9 }, port, spawnProcess })).rejects.toThrow(
      'the marker of C:\\node.exe reaches a kept command by its path, and only a descriptor was given',
    );
  });

  it('tells the exit code the keeper reports for the command, not the exit of the keeper', async () => {
    const { fake, port, seen, spawnProcess } = world(running);
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: 'C:\\node.exe', args: [], stdio: ['ignore', 'pipe', 'pipe'], port, spawnProcess });
    const exits: unknown[] = [];
    launched.onExit((exit) => exits.push(exit), () => exits.push('failed'));
    await settle();
    seen[0]?.child.emit('exit', 0, null);
    await settle();
    expect(exits).toEqual([]);
    fake.keepers[0]?.say('exit 3\n');
    await settle();
    expect(exits).toEqual([{ code: 3, signal: null }]);
  });

  it('tells a command whose keeper was lost without an exit word as killed', async () => {
    const { fake, port, spawnProcess } = world((keeper, index) => {
      if (index === 0) running(keeper);
      else keeper.say('failed job-absent 2\n');
    });
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: 'C:\\node.exe', args: [], stdio: ['ignore', 'pipe', 'pipe'], port, spawnProcess });
    const exits: unknown[] = [];
    launched.onExit((exit) => exits.push(exit), () => exits.push('failed'));
    await settle();
    fake.keepers[0]?.hangUp();
    await settle();
    expect(exits).toEqual([{ code: null, signal: 'SIGKILL' }]);
  });

  it('tells a refused containment as a failure, never as an exit', async () => {
    const { port, spawnProcess } = world((keeper) => keeper.say('failed containment-unavailable 5\n'));
    const launched = await launchGroupLeader({ protection: TEST_CHILD_UNPROTECTED, file: 'C:\\node.exe', args: [], stdio: ['ignore', 'pipe', 'pipe'], port, spawnProcess });
    const failures: unknown[] = [];
    launched.onExit(() => failures.push('exit'), (error) => failures.push(error));
    await settle();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(GroupContainmentError);
  });
});

describe('a program that outlives the product is started apart, in no group of the port', () => {
  it('is a detached spawn with the options of the caller', async () => {
    const seen: Spawned[] = [];
    const child = launchApart('/usr/bin/open', ['https://example.test'], { stdio: 'ignore', windowsHide: true }, recordingSpawn(LEADER_PID, seen));
    expect(child).toBe(seen[0]?.child);
    expect(seen[0]?.options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true });
  });
});
