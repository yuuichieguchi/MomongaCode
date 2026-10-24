import fs from 'node:fs';
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

const supervisor = await startSupervisor({
  home,
  version: '0.0.0-fixture',
  launcher: () => ({ command: process.execPath, args: [child] }),
  env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home },
  spawn,
  stdout: process.stdout,
  watchSettings: false,
  orphanReapGraceMs: 200,
});

process.on('SIGTERM', () => {
  void supervisor.close().then(() => process.exit(0));
});
