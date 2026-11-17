import fs from 'node:fs';
import { secretStoreEnvFor } from '@momonga/foundation';
import { createUserSettingsCache, noKeptRecords } from '@momonga/config';
import { FIRST_GENERATION, createJsonLogger, momongaPaths, roleEndpoint, scopeToGeneration, systemClock } from '@momonga/foundation';
import { prepareGenerationForTest } from '@momonga/testkit/first-generation';
import { DEFAULT_INTERVALS, HELD_RETRY_MS, STARTUP_TIMEOUT_MS } from '../../src/constants.ts';
import { createChildManager } from '../../src/child-manager.ts';
import { DEFAULT_RESTART_POLICY } from '../../src/restart-policy.ts';
import { createSpawnPort } from '../../src/spawn-port.ts';
import { testKernelLock, testProcessInspector } from '@momonga/testkit';

const flag = (name: string): string[] =>
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith(`--${name}=`))
    .map((arg) => arg.slice(name.length + 3));

const home = flag('home')[0];
const child = flag('child')[0];
if (home === undefined || child === undefined) throw new Error('p2-manager-fixture needs --home and --child');

const paths = momongaPaths(home, process.platform, {});
const layout = prepareGenerationForTest(home, FIRST_GENERATION, '0.0.0-fixture');
const logger = createJsonLogger({ service: 'supervisor', clock: systemClock, stream: process.stderr });
const settings = createUserSettingsCache({ env: process.env, home, onWarning: () => undefined, keptRecords: noKeptRecords });
const loaded = await settings.load(new AbortController().signal);
const manager = createChildManager({
  inspector: testProcessInspector(),
  lockMechanism: testKernelLock(),
  role: 'runtime',
  version: '0.0.0-fixture',
  onVersionMismatch: (mismatch) => {
    process.stderr.write(`version mismatch: ${mismatch.childVersion}\n`);
  },
  home,
  paths: scopeToGeneration(paths, FIRST_GENERATION),
  generation: FIRST_GENERATION,
  isRetiring: () => false,
  onRetiredExit: () => undefined,
  endpoint: roleEndpoint(layout, 'runtime'),
  onReady: () => undefined,
  onProgress: () => undefined,
  launcher: () => ({ command: process.execPath, args: [child, ...flag('child-arg')] }),
  env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home },
  secretStoreEnv: await secretStoreEnvFor({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home }, { platform: process.platform, uid: process.getuid?.(), realPathOf: (file: string) => fs.realpathSync(file) }),
  spawn: createSpawnPort(),
  settings,
  signal: new AbortController().signal,
  logger,
  clock: systemClock,
  timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
  random: () => 0.5,
  restart: DEFAULT_RESTART_POLICY,
  intervals: DEFAULT_INTERVALS,
  startupTimeoutMs: STARTUP_TIMEOUT_MS,
  heldRetryMs: HELD_RETRY_MS,
  isDraining: () => false,
  onBackgroundError: (error) => {
    process.stderr.write(`${String(error)}\n`);
  },
  onTransientError: (error) => {
    process.stderr.write(`transient: ${String(error)}\n`);
  },
});

process.on('SIGTERM', () => {
  void manager.stop('shutdown', 'term').then(() => process.exit(0));
});

await manager.spawnWith(loaded, 'initial');
const pid = manager.health().pid;
process.stdout.write(`${JSON.stringify({ childPid: pid })}\n`);
setInterval(() => undefined, 60_000);
