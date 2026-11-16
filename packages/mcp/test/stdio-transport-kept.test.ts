import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeptGroupControl, createProcessGroupPort, nodeCommandRunner, nodeFileSystem } from '@momonga/foundation';
import type { GroupLaunchRequest } from '@momonga/foundation';
import { TEST_STDIO_LAUNCH, testProcessInspector } from '@momonga/testkit';
import { answeringMembers, fakeKeeperHost, settle } from '../../foundation/test/support/fake-keeper.ts';
import { createStdioTransport } from '../src/stdio-transport.ts';

const KEEPER_PID = 100;
const COMMAND_PID = 200;

type SpawnProcess = NonNullable<GroupLaunchRequest['spawnProcess']>;

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

const keptWorld = () => {
  const fake = fakeKeeperHost((keeper) => {
    answeringMembers(() => [COMMAND_PID])(keeper);
    keeper.say(`started ${COMMAND_PID} 3\n`);
  });
  const port = createProcessGroupPort('win32', { run: nodeCommandRunner, env: {}, kept: createKeptGroupControl(fake.host) });
  const spawnProcess = ((file: string, args: readonly string[]) => {
    fake.start(file, args);
    const child = Object.assign(new EventEmitter(), { pid: KEEPER_PID, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null], kill: () => true });
    process.nextTick(() => child.emit('spawn'));
    return child;
  }) as unknown as SpawnProcess;
  return { fake, port, spawnProcess };
};

const transportOver = (world: ReturnType<typeof keptWorld>) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-kept-'));
  folders.push(folder);
  const markers = path.join(folder, 'markers');
  fs.mkdirSync(markers);
  const transport = createStdioTransport({
    launch: { protection: TEST_STDIO_LAUNCH.protection, commandOf: (argv) => ({ file: 'C:\\node.exe', args: argv.slice(1) }) },
    files: nodeFileSystem,
    name: 'kept',
    config: { command: process.execPath, args: ['server.js'] },
    projectDir: folder,
    baseEnv: { PATH: '/usr/bin:/bin' },
    closeGraceMs: 0,
    markers: { dir: markers, inspector: testProcessInspector(), onWarning: () => undefined },
    port: world.port,
    spawnProcess: world.spawnProcess,
  });
  return { transport, markers };
};

describe('a stdio MCP server launched over a job group port', () => {
  it('is started through the keeper of the port it was given', async () => {
    const world = keptWorld();
    const { transport } = transportOver(world);
    await transport.start();
    await settle();
    expect(world.fake.keepers).toHaveLength(1);
    expect(transport.pgid).toBe(KEEPER_PID);
  });

  it('records the job name of its group in its marker, so a later process can recall the job', async () => {
    const world = keptWorld();
    const { transport, markers } = transportOver(world);
    await transport.start();
    await settle();
    const [marker] = fs.readdirSync(markers);
    expect(marker).toBeDefined();
    const text = fs.readFileSync(path.join(markers, marker ?? ''), 'utf8');
    expect(text).toContain(`j${world.port.names?.nameOf(KEEPER_PID) ?? 'no job name'}\n`);
  });

  it('terminates its job through the keeper when it is closed', async () => {
    const world = keptWorld();
    const { transport } = transportOver(world);
    await transport.start();
    await settle();
    const keeper = world.fake.keepers[0];
    const closing = transport.close(0);
    await vi.waitFor(() => expect(keeper?.written).toContain('terminate\n'));
    keeper?.say('empty\n');
    keeper?.say('exit 1\n');
    await closing;
  });
});
