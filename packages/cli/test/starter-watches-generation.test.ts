import fs from 'node:fs';
import { EXIT_ALREADY_RUNNING, FIRST_GENERATION, STARTUP_TIMEOUT_MS, ensureMomongaDirs, generationLayout, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import type { SupervisorChildHealth } from '@momonga/protocol';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { DaemonStartError, ensureDaemon } from '../src/daemon/ensure-daemon.ts';
import type { DaemonPorts } from '../src/daemon/ensure-daemon.ts';
import type { CliClock, SelfExecutable } from '../src/ports.ts';
import { readyChildren, recordingSpawn, startFakeSupervisor, virtualClock } from './fake-supervisor.ts';
import type { FakeSupervisor } from './fake-supervisor.ts';

const VERSION = '1.2.3';
const SELF: SelfExecutable = { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' };
const STARTING_PID = 7001;
const SECOND_GENERATION_PID = 7002;

const startingChildren = (): SupervisorChildHealth[] => [
  { role: 'gateway', state: 'starting', restarts: 0, consecutiveFailures: 0 },
  { role: 'runtime', state: 'starting', restarts: 0, consecutiveFailures: 0 },
];

const heldChildren = (): SupervisorChildHealth[] => [
  { role: 'gateway', state: 'held-config', restarts: 0, consecutiveFailures: 0, heldReason: 'invalid settings' },
  { role: 'runtime', state: 'ready', pid: 102, restarts: 0, consecutiveFailures: 0 },
];

const setup = async (context: TestContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  const running: FakeSupervisor[] = [];
  registerCleanup(context, async () => {
    await Promise.all(running.map((supervisor) => supervisor.stop()));
  });
  const start = async (options: Omit<Parameters<typeof startFakeSupervisor>[0], 'paths'>): Promise<FakeSupervisor> => {
    const supervisor = await startFakeSupervisor({ paths, ...options });
    running.push(supervisor);
    return supervisor;
  };
  const portsWith = (spawn: DaemonPorts['spawnDetached'], clock: CliClock): DaemonPorts => ({ version: VERSION, env: { PATH: '/usr/bin' }, home, clock, self: SELF, spawnDetached: spawn });
  return { home, paths, start, portsWith };
};

const clockThatReadies = (supervisor: FakeSupervisor, readyAtMs: number): CliClock => {
  const clock = virtualClock();
  let ready = false;
  return {
    now: clock.now,
    sleep: async (ms, signal) => {
      await clock.sleep(ms, signal);
      if (ready || clock.now() < readyAtMs) return;
      ready = true;
      await supervisor.becomeReady();
    },
  };
};

describe('the client that starts a generation watches that generation, not run/current (rule 5b)', () => {
  it('reports a child held by its configuration on a home with no run/current, not the ready timeout', async (context) => {
    const { paths, start, portsWith } = await setup(context);
    await start({ version: VERSION, pid: STARTING_PID, children: heldChildren() });
    expect(fs.existsSync(paths.current)).toBe(false);
    const { spawn } = recordingSpawn(() => undefined);

    const failure = await ensureDaemon(portsWith(spawn, virtualClock()), paths).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonStartError);
    expect((failure as DaemonStartError).message).toBe(`gateway is held by its configuration: invalid settings; see ${paths.logFiles.supervisor}`);
  });

  it('lets a second client that arrives during the start end on the same starting generation, with no extra supervisor left running', async (context) => {
    const { home, paths, start, portsWith } = await setup(context);
    const starting = await start({ version: VERSION, pid: STARTING_PID, children: startingChildren() });
    const clock = clockThatReadies(starting, STARTUP_TIMEOUT_MS / 2);
    const first = recordingSpawn(() => undefined);
    const second = recordingSpawn(() => undefined);
    const bounds = { readyMs: STARTUP_TIMEOUT_MS, stopMs: STARTUP_TIMEOUT_MS };

    const firstStart = ensureDaemon(portsWith(first.spawn, clock), paths, { bounds });
    const secondStart = ensureDaemon(portsWith(second.spawn, clock), paths, { bounds });
    const [{ health: firstHealth }, { health: secondHealth }] = await Promise.all([firstStart, secondStart]);

    expect(firstHealth.pid).toBe(STARTING_PID);
    expect(secondHealth.pid).toBe(STARTING_PID);
    expect(secondHealth.children.map((child) => child.state)).toEqual(['ready', 'ready']);
    expect(starting.healthRequests).toBeGreaterThan(0);
    expect([...first.spawned, ...second.spawned]).toEqual([]);
    expect(JSON.parse(fs.readFileSync(paths.current, 'utf8'))).toEqual({ generation: FIRST_GENERATION, version: VERSION, sockets: generationLayout(home, FIRST_GENERATION).sockets });
  });

  it('resolves the starter later requests through run/current once the started generation is current (rule 5a)', async (context) => {
    const { home, paths, start, portsWith } = await setup(context);
    const starting = await start({ version: VERSION, pid: STARTING_PID, children: startingChildren() });
    const { spawn, spawned } = recordingSpawn(() => undefined);
    const ports = portsWith(spawn, clockThatReadies(starting, STARTUP_TIMEOUT_MS / 2));
    const bounds = { readyMs: STARTUP_TIMEOUT_MS, stopMs: STARTUP_TIMEOUT_MS };

    expect((await ensureDaemon(ports, paths, { bounds })).health.pid).toBe(STARTING_PID);
    await start({ version: VERSION, pid: SECOND_GENERATION_PID, generation: 2, children: readyChildren() });
    await publishCurrentGeneration(paths, { generation: 2, version: VERSION, sockets: generationLayout(home, 2).sockets });

    const spawnsBefore = spawned.length;
    expect((await ensureDaemon(ports, paths, { bounds })).health.pid).toBe(SECOND_GENERATION_PID);
    expect(spawned).toHaveLength(spawnsBefore);
  });
});
