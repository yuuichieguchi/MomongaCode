import { createManagedServer } from '@momonga/gateway';
import { kernelLockNamed, momongaLayout, systemTiming } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { FM_SERVER } from '@momonga/protocol';
import { fakeExec, testEndpointScope, testProcessInspector } from '@momonga/testkit';
import { cliProbeInstance } from '../src/commands/gateway.ts';

const [home, binary, mechanism] = process.argv.slice(2) as [string, string, KernelLockMechanism['name']];
const instance = await cliProbeInstance({ platform: process.platform, endpointScope: testEndpointScope }, momongaLayout(home, process.platform, {}), FM_SERVER, 'apple');
const server = createManagedServer({
  inspector: testProcessInspector(),
  lock: kernelLockNamed(mechanism),
  description: { ...FM_SERVER, restart: { ...FM_SERVER.restart, maxRestarts: 0 } },
  target: 'apple',
  lockPath: instance.lockPath,
  socketPath: instance.socketPath,
  markerDirectory: instance.markerDirectory,
  readyTimeoutMs: 15_000,
  readStopGraceMs: () => 1000,
  binary,
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home },
  exec: fakeExec,
  timers: systemTiming,
  onWarning: (message) => process.stderr.write(`${message}\n`),
});
await server.start();
process.stdout.write('started\n');
process.stdin.resume();
