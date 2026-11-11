import { FIRST_GENERATION, momongaPaths, systemClock } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { prepareGenerationForTest, registerOwned, withTempDir, testKernelLock, testProcessInspector } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { startSupervisor } from '../../src/start-supervisor.ts';
import type { SupervisorOptions, SupervisorProcess } from '../../src/start-supervisor.ts';
import type { MarkerPorts } from '../../src/orphans.ts';
import { createFakeSpawnPort } from './p2-fake-spawn-port.ts';
import type { FakeChild, FakeSpawnPort } from './p2-fake-spawn-port.ts';
import { createLogBuffer } from './p2-log-buffer.ts';
import type { LogBuffer } from './p2-log-buffer.ts';
import { writeSettings } from './p2-manager-harness.ts';
import { testHostPath } from '@momonga/testkit';

export type SupervisorHarness = {
  home: string;
  paths: MomongaPaths;
  port: FakeSpawnPort;
  log: LogBuffer;
  reapCalls: string[];
  supervisor: SupervisorProcess;
};

export const startSupervisorHarness = async (
  context: CleanupContext,
  options: { settings?: unknown; invalidSettings?: boolean; markerPorts?: MarkerPorts; overrides?: Partial<SupervisorOptions>; home?: string } = {},
): Promise<SupervisorHarness> => {
  const home = options.home ?? withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, {});
  if (options.invalidSettings === true) writeSettings(home, '{ "models": ');
  else if (options.settings !== undefined) writeSettings(home, options.settings);
  prepareGenerationForTest(home, FIRST_GENERATION, '1.2.3');
  const port = createFakeSpawnPort();
  const log = createLogBuffer(systemClock);
  const reapCalls: string[] = [];
  const abortAtCleanup = async (process: SupervisorProcess): Promise<void> => {
    const exited = new Set<FakeChild>();
    port.onSignal = (child, signal) => {
      if (exited.has(child)) return;
      exited.add(child);
      queueMicrotask(() => child.exit(null, signal === 'group' ? 'SIGKILL' : signal));
    };
    await process.abort();
  };
  const supervisor = await registerOwned(context, () => startSupervisor({
    lockMechanism: testKernelLock(),
    inspector: testProcessInspector(),
    home,
    version: '1.2.3',
    generation: FIRST_GENERATION,
    childCounts: async () => ({}),
    launcher: (role) => ({ command: process.execPath, args: [`/opt/momonga/${role}-bin.ts`] }),
    env: { PATH: testHostPath('/usr/bin:/bin'), HOME: home },
    spawn: port,
    logger: log.logger,
    stdout: { write: () => true },
    watchSettings: false,
    random: () => 0,
    restart: { baseMs: 1, maxMs: 1, minMs: 1 },
    orphanReapGraceMs: 200,
    markerPorts: {
      findHolders: async () => [],
      reapMarkerDirectory: async () => ({ reaped: 0, kept: 0 }),
      reapMarkedProcesses: async (reapOptions) => {
        reapCalls.push(reapOptions.marker);
        return { removed: true };
      },
      ...options.markerPorts,
    },
    ...options.overrides,
  }), abortAtCleanup);
  return { home, paths, port, log, reapCalls, supervisor };
};
