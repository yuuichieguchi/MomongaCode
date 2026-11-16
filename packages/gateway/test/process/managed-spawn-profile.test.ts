import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJsonLogger, FIRST_GENERATION, momongaPaths, protectedAreasOf } from '@momonga/foundation';
import type { ChildLaunch, ChildProtection } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeClock, createFakeFm, createFakeTimers, fakeExec } from '@momonga/testkit';
import { noneSandboxLaunchOf } from '@momonga/sandbox';
import type { ManagedServerOptions } from '../../src/managed/server.ts';
import { START_MS, makeDir } from '../gateway-helpers.ts';
import { placeFakeFm } from '../fm-record-support.ts';
import { PROCESS_VERSION, baseEnv, launchGateway, makeHome, writeSettings, modelsOf } from '../gateway-process-helpers.ts';
import { FakeChild, SERVER_KINDS, createManagedServer, createManualTimers, makeShortDir } from '../managed/managed-support.ts';
import type { ManagedServerHandle } from '../managed/managed-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const servedOptions: ManagedServerOptions[] = [];

vi.mock('../../src/managed/server.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/managed/server.ts')>();
  return {
    ...original,
    createManagedServer: (options: ManagedServerOptions) => {
      servedOptions.push(options);
      return original.createManagedServer(options);
    },
  };
});

const dirs: string[] = [];
const children: FakeChild[] = [];
const servers: ManagedServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const child of children.splice(0)) await child.crash(0, null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HOME_DENIED: ChildProtection = { kind: 'home-denied', home: '/home/person', denied: ['/home/person/.momonga'] };

const wrappingLaunch: ChildLaunch = {
  protection: HOME_DENIED,
  commandOf: (argv, scratch) => ({ file: '/usr/bin/wrapper', args: [...scratch.flatMap((folder) => ['--allow', folder]), '--', ...argv] }),
};

const hostExec = async (file: string, args: readonly string[]) => {
  if (path.basename(file) === 'sw_vers') return { exitCode: 0, stdout: `${FAKE_OS_BUILD}\n`, stderr: '' };
  if (args[0] === 'license') return { exitCode: 0, stdout: 'Agreed', stderr: '' };
  if (args[0] === 'available') return { exitCode: 0, stdout: 'System model available', stderr: '' };
  return fakeExec(file, args);
};

describe('every managed model server is spawned with the self-protection of the home (runtime-service DECISION-1 layer (i))', () => {
  it('the spawn port receives the protection and the command the launch wraps, the socket folder allowed back', async () => {
    const [kind] = SERVER_KINDS;
    if (kind === undefined) throw new Error('no server kind');
    const dir = makeShortDir(dirs);
    const socket = path.join(dir, `${kind.target}.sock`);
    const calls: { file: string; args: readonly string[]; protection: unknown }[] = [];
    const server = createManagedServer({
      description: kind.description(),
      target: kind.target,
      binary: '/opt/managed/bin/server',
      socketPath: socket,
      lockPath: path.join(dir, `${kind.target}.lock`),
      readyTimeoutMs: 400,
      exec: kind.metExec,
      launch: wrappingLaunch,
      spawn: (file, args, protection) => {
        calls.push({ file, args, protection });
        const created = new FakeChild(socket, kind.readyPath, {});
        children.push(created);
        return created;
      },
      timers: createManualTimers().timers,
      readStopGraceMs: () => 30,
      onWarning: () => undefined,
    });
    servers.push(server);

    await server.start(new AbortController().signal);

    expect(calls).toEqual([{ file: '/usr/bin/wrapper', args: ['--allow', dir, '--', '/opt/managed/bin/server', ...kind.argvOf(socket)], protection: HOME_DENIED }]);
  });

  it('the launch of a managed server denies the areas of the home on macOS and on Linux with bubblewrap, and is unprotected with its reason on Linux without it', async () => {
    const home = '/home/person';
    const env = {};
    const present = async (): Promise<boolean> => true;
    const absent = async (): Promise<boolean> => false;

    const mac = await noneSandboxLaunchOf({ home, platform: 'darwin', env, isUsableBinary: absent });
    const linux = await noneSandboxLaunchOf({ home, platform: 'linux', env, isUsableBinary: present });
    const bare = await noneSandboxLaunchOf({ home, platform: 'linux', env, isUsableBinary: absent });

    expect(mac.protection).toEqual({ kind: 'home-denied', home, denied: protectedAreasOf(momongaPaths(home, 'darwin', env)) });
    expect(mac.commandOf(['/bin/server'], []).file).toBe('/usr/bin/sandbox-exec');
    expect(linux.protection.kind).toBe('home-denied');
    expect(bare.protection.kind).toBe('unprotected');
    expect(bare.commandOf(['/bin/server', 'run'], [])).toEqual({ file: '/bin/server', args: ['run'] });
  });

  it.runIf(process.platform === 'darwin')('the gateway process hands every managed server it builds the protection that denies the home (macOS, where the host always has the sandbox)', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ apple: { adapter: 'managed', server: 'fm', model: 'system' } }) });
    await placeFakeFm(home, fm.binaryPath);
    const clock = createFakeClock(START_MS);
    await launchGateway({
      generation: FIRST_GENERATION,
      home,
      env: baseEnv(home),
      version: PROCESS_VERSION,
      exec: hostExec,
      execWithStdin: async () => ({ exitCode: 0, stdout: '5\n', stderr: '' }),
      clock,
      timers: createFakeTimers(clock),
      logger: createJsonLogger({ service: 'gateway', clock, stream: { write: () => true } }),
    });

    const managed = servedOptions.filter((options) => options.target === 'apple/system');
    expect(managed.length).toBeGreaterThan(0);
    for (const options of managed) expect(options.launch.protection).toMatchObject({ kind: 'home-denied', home });
  });
});
