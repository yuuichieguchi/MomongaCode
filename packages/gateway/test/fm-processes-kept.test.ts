import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeptGroupControl, createProcessGroupPort, nodeCommandRunner } from '@momonga/foundation';
import type { GroupLaunchRequest } from '@momonga/foundation';
import { TEST_UNPROTECTED_LAUNCH, testProcessInspector } from '@momonga/testkit';
import { answeringMembers, fakeKeeperHost, settle } from '../../foundation/test/support/fake-keeper.ts';
import { createGroupSpawn } from '../src/managed/fm-processes.ts';

const KEEPER_PID = 100;
const COMMAND_PID = 200;

type SpawnProcess = NonNullable<GroupLaunchRequest['spawnProcess']>;

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

const keptSpawn = () => {
  const fake = fakeKeeperHost((keeper) => {
    answeringMembers(() => [COMMAND_PID])(keeper);
    keeper.say(`started ${COMMAND_PID} 3\n`);
  });
  const port = createProcessGroupPort('win32', { run: nodeCommandRunner, env: {}, kept: createKeptGroupControl(fake.host) });
  const spawnProcess = ((file: string, args: readonly string[]) => {
    fake.start(file, args);
    return Object.assign(new EventEmitter(), { pid: KEEPER_PID, stdin: null, stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null], kill: () => true });
  }) as unknown as SpawnProcess;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-kept-'));
  folders.push(folder);
  const markerDirectory = path.join(folder, 'markers');
  fs.mkdirSync(markerDirectory);
  const spawn = createGroupSpawn({ env: { PATH: '/usr/bin:/bin' }, markerDirectory, onWarning: () => undefined, inspector: testProcessInspector(), port, spawnProcess });
  return { fake, port, spawn, markerDirectory };
};

describe('the managed model server launched over a job group port', () => {
  it('is started through the keeper of the port it was given', async () => {
    const { fake, spawn } = keptSpawn();
    await spawn('C:\\fm\\server.exe', ['--serve'], TEST_UNPROTECTED_LAUNCH.protection);
    await settle();
    expect(fake.keepers).toHaveLength(1);
  });

  it('records the job name of its group in its marker', async () => {
    const { port, spawn, markerDirectory } = keptSpawn();
    await spawn('C:\\fm\\server.exe', ['--serve'], TEST_UNPROTECTED_LAUNCH.protection);
    await settle();
    const [marker] = fs.readdirSync(markerDirectory);
    await vi.waitFor(() => expect(fs.readFileSync(path.join(markerDirectory, marker ?? ''), 'utf8')).toContain(`j${port.names?.nameOf(KEEPER_PID) ?? 'no job name'}\n`));
  });

  it('terminates its job through the keeper when it is killed', async () => {
    const { fake, spawn } = keptSpawn();
    const child = await spawn('C:\\fm\\server.exe', ['--serve'], TEST_UNPROTECTED_LAUNCH.protection);
    await settle();
    const killed = child.kill('SIGKILL');
    await settle();
    expect(fake.keepers[0]?.written).toContain('terminate\n');
    fake.keepers[0]?.say('empty\n');
    await killed;
  });
});
