import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createKeptGroupControl, createProcessGroupPort, nodeCommandRunner } from '@momonga/foundation';
import type { GroupLaunchRequest } from '@momonga/foundation';
import { answeringMembers, fakeKeeperHost, settle } from '../../foundation/test/support/fake-keeper.ts';
import type { FakeKeeper } from '../../foundation/test/support/fake-keeper.ts';
import type { SpawnPortOptions } from '../src/child-manager.ts';
import { spawnPortOverFakeHost } from './support/tracked-spawn-port.ts';

const KEEPER_PID = 100;
const COMMAND_PID = 200;

type SpawnProcess = NonNullable<GroupLaunchRequest['spawnProcess']>;

const OPTIONS: SpawnPortOptions = { cwd: 'C:\\work', env: { SystemRoot: 'C:\\Windows' }, markerFile: 'C:\\m\\marker', stdio: ['ignore', 'pipe', 'pipe', 'pipe', 17] };

export const keptWorld = (script: (keeper: FakeKeeper) => void = (keeper) => keeper.say(`started ${COMMAND_PID} 3\n`), withLifeline = true) => {
  const fake = fakeKeeperHost((keeper) => {
    answeringMembers(() => [COMMAND_PID])(keeper);
    script(keeper);
  });
  const port = createProcessGroupPort('win32', { run: nodeCommandRunner, env: {}, kept: createKeptGroupControl(fake.host) });
  const lifelines: PassThrough[] = [];
  const spawnProcess = ((file: string, args: readonly string[]) => {
    fake.start(file, args);
    const lifeline = new PassThrough();
    lifelines.push(lifeline);
    return Object.assign(new EventEmitter(), { pid: KEEPER_PID, stdin: null, stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, withLifeline ? lifeline : null], kill: () => true });
  }) as unknown as SpawnProcess;
  return { fake, port, lifelines, spawn: spawnPortOverFakeHost({ port, spawnProcess }) };
};

describe('the spawn port through the keeper', () => {
  it('gives the pid of the command the keeper started, not the pid of the keeper', async () => {
    const { spawn } = keptWorld();
    const handle = spawn('C:\\node.exe', ['runtime.js'], OPTIONS);
    const pids: number[] = [];
    handle.onCommandPid((pid) => pids.push(pid));
    await settle();
    expect(pids).toEqual([COMMAND_PID]);
    expect(handle.pid).toBe(KEEPER_PID);
  });

  it('gives the command pid to a listener that arrives after the keeper reported it', async () => {
    const { spawn } = keptWorld();
    const handle = spawn('C:\\node.exe', ['runtime.js'], OPTIONS);
    await settle();
    const pids: number[] = [];
    handle.onCommandPid((pid) => pids.push(pid));
    expect(pids).toEqual([COMMAND_PID]);
  });

  const terminates = (keeper: FakeKeeper | undefined): number => (keeper?.written ?? []).filter((line) => line === 'terminate\n').length;

  it('stops gracefully with SIGTERM: the lifeline is closed and the job is not terminated', async () => {
    const { spawn, fake, lifelines } = keptWorld();
    const handle = spawn('C:\\node.exe', ['runtime.js'], OPTIONS);
    await settle();
    handle.kill('SIGTERM');
    await settle();
    expect(lifelines[0]?.destroyed).toBe(true);
    expect(terminates(fake.keepers[0])).toBe(0);
  });

  it('terminates the job at once for SIGINT', async () => {
    const { spawn, fake } = keptWorld();
    const handle = spawn('C:\\node.exe', ['runtime.js'], OPTIONS);
    await settle();
    handle.kill('SIGINT');
    await settle();
    expect(terminates(fake.keepers[0])).toBe(1);
  });

  it('a SIGINT after a SIGTERM still terminates the job, once, without waiting on the graceful stop', async () => {
    const { spawn, fake } = keptWorld();
    const handle = spawn('C:\\node.exe', ['runtime.js'], OPTIONS);
    await settle();
    handle.kill('SIGTERM');
    handle.kill('SIGINT');
    await settle();
    expect(terminates(fake.keepers[0])).toBe(1);
  });

  it('kills the group through the job of the port it was given, also after the lifeline closed', async () => {
    const { spawn, fake } = keptWorld();
    const handle = spawn('C:\\node.exe', ['runtime.js'], OPTIONS);
    await settle();
    handle.kill('SIGTERM');
    const killed = handle.killGroup();
    await settle();
    expect(terminates(fake.keepers[0])).toBe(1);
    fake.keepers[0]?.say('empty\n');
    await killed;
  });

  it('refuses a graceful stop of a child without a lifeline, which a job port could only terminate', async () => {
    const { spawn } = keptWorld(undefined, false);
    const handle = spawn('C:\\node.exe', ['runtime.js'], OPTIONS);
    await settle();
    expect(() => handle.kill('SIGTERM')).toThrow('has no lifeline');
  });
});
