import fs from 'node:fs';
import { FIRST_GENERATION } from '@momonga/foundation';
import { prepareGenerationForTest } from '@momonga/testkit/first-generation';
import { registerOwned } from '@momonga/testkit/test-support';
import { startSupervisor } from '../../src/start-supervisor.ts';
import { createSpawnPort } from '../../src/spawn-port.ts';
import type { SpawnPort } from '../../src/child-manager.ts';

const flag = (name: string): string | undefined =>
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const home = flag('home');
const child = flag('child');
if (home === undefined || child === undefined) throw new Error('p2-supervisor-fixture needs --home and --child');

const realPort = createSpawnPort();
const leakedFds: number[] = [];
const spawn: SpawnPort = process.argv.includes('--leak-marker-fd')
  ? (command, args, options) => {
      leakedFds.push(fs.openSync(`/dev/fd/${options.stdio[4]}`, 'r'));
      return realPort(command, args, options);
    }
  : realPort;

prepareGenerationForTest(home, FIRST_GENERATION, '0.0.0-fixture');
const closeOnSigterm = (close: () => Promise<void>): void => {
  process.on('SIGTERM', () => {
    void close().then(() => process.exit(0));
  });
};

await registerOwned(closeOnSigterm, () => startSupervisor({
  home,
  version: '0.0.0-fixture',
  generation: FIRST_GENERATION,
  launcher: () => ({ command: process.execPath, args: [child] }),
  env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home },
  spawn,
  stdout: process.stdout,
  watchSettings: false,
  orphanReapGraceMs: 200,
}));
