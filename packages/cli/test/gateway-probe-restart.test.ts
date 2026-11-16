import { nodeFilesLockedBy } from '../src/node-ports.ts';
import fs from 'node:fs';
import path from 'node:path';
import { ensureMomongaDirs, generationLayout, momongaPaths } from '@momonga/foundation';
import { registerCleanup, testKernelLock, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { restartDaemon } from '../src/commands/gateway.ts';
import { DaemonStartError } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import type { CliPorts, SelfExecutable } from '../src/ports.ts';
import { createFakeWork, installedProgram, recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
import type { FakeSupervisor, SpawnedProcess } from './fake-supervisor.ts';

const VERSION = '1.2.3';
const BOUNDS = { readyMs: 500, stopMs: 500 };
const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
  await ensureMomongaDirs(paths);
  const work = createFakeWork();
  const running: FakeSupervisor[] = [];
  registerCleanup(context, async () => {
    await work.settled();
    await Promise.all(running.map((supervisor) => supervisor.stop()));
  });
  const start = async (options: Omit<Parameters<typeof startFakeSupervisor>[0], 'paths' | 'work'>): Promise<FakeSupervisor> => {
    const supervisor = await startFakeSupervisor({ paths, work, ...options });
    running.push(supervisor);
    return supervisor;
  };
  const printed: string[] = [];
  const portsWith = (spawn: DaemonPorts['spawnDetached'], version = VERSION): Pick<CliPorts, 'stdout'> & DaemonPorts => ({
    files: nodeFilesLockedBy(testKernelLock),
    version,
    env: { PATH: '/usr/bin' },
    home,
    clock: virtualClock(work),
    self: SELF,
    spawnDetached: spawn,
    ...installedProgram(version).ports,
    stdout: { write: (text: string) => void printed.push(text) },
  });
  const counter = path.join(paths.run, 'generation.counter');
  return { home, paths, start, portsWith, printed, counter };
};

const generationOf = (spawned: SpawnedProcess): number => Number(spawned.args.find((arg) => arg.startsWith('--generation='))?.slice('--generation='.length));

describe('gateway probe restarts by starting a generation, never by stopping one (A6, 15.14 P3, 20.21)', () => {
  it('starts a generation of the serving version beside it, never joins a pending start, stops nothing, and says so', async (context) => {
    const { home, paths, start, portsWith, printed, counter } = await setup(context);
    fs.writeFileSync(counter, '2');
    const serving = await start({ version: VERSION, generation: 1 });
    const pending = await start({ version: VERSION, generation: 2, publishes: false });
    const { spawn, spawned } = recordingSpawn((spec) => {
      void start({ version: VERSION, generation: generationOf(spec) });
      return undefined;
    });

    await restartDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(serving.shutdowns).toBe(0);
    expect(pending.shutdowns).toBe(0);
    expect(spawned.map(generationOf)).toEqual([3]);
    expect(JSON.parse(fs.readFileSync(generationLayout(home, 3).startRecord, 'utf8'))).toMatchObject({ version: VERSION });
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toMatchObject({ generation: 3, version: VERSION });
    expect(printed).toEqual([`started a new daemon (v${VERSION}) so that the gateway reads the record; work in the old one keeps running.\n`]);
  });

  it('starts nothing when no daemon serves, and says the record is read when one starts', async (context) => {
    const { paths, portsWith, printed, counter } = await setup(context);
    const { spawn, spawned } = recordingSpawn(() => undefined);

    await restartDaemon(portsWith(spawn), paths, { bounds: BOUNDS });

    expect(spawned).toEqual([]);
    expect(fs.existsSync(counter)).toBe(false);
    expect(printed).toEqual(['no daemon is running; the record is read when it starts.\n']);
  });

  it('a caller newer than the serving daemon starts a generation of its own version', async (context) => {
    const { paths, start, portsWith, printed, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    const serving = await start({ version: VERSION, generation: 1 });
    const { spawn, spawned } = recordingSpawn((spec) => {
      void start({ version: '1.2.4', generation: generationOf(spec) });
      return undefined;
    });

    await restartDaemon(portsWith(spawn, '1.2.4'), paths, { bounds: BOUNDS });

    expect(serving.shutdowns).toBe(0);
    expect(spawned.map(generationOf)).toEqual([2]);
    expect(printed).toEqual(['started a new daemon (v1.2.4) so that the gateway reads the record; work in the old one keeps running.\n']);
  });

  it('a caller older than the serving daemon is refused with the one-shot text, and nothing starts', async (context) => {
    const { paths, start, portsWith, printed, counter } = await setup(context);
    fs.writeFileSync(counter, '1');
    const serving = await start({ version: VERSION, generation: 1 });
    const { spawn, spawned } = recordingSpawn(() => undefined);

    const failure = await restartDaemon(portsWith(spawn, '1.2.2'), paths, { bounds: BOUNDS }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as Error).message).toBe(`momonga was updated to v${VERSION} while this command was running; run it again. Your tasks are not affected.`);
    expect(serving.shutdowns).toBe(0);
    expect(spawned).toEqual([]);
    expect(printed).toEqual([]);
    expect(fs.readFileSync(counter, 'utf8')).toBe('1');
  });
});
