import { ensureMomongaDirs, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import path from 'node:path';
import { startService } from '../../runtime/test/service/helpers.ts';
import { createRuntimeClient } from '../src/client/runtime-client.ts';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import type { CliPorts } from '../src/ports.ts';
import { terminalPorts } from '../src/terminal-writer.ts';

export const REAL_RUNTIME_VERSION = '9.9.9';

export type RealRuntime = {
  service: Awaited<ReturnType<typeof startService>>;
  paths: MomongaPaths;
  client: RuntimeClient;
  ports: CliPorts;
  stdout: string[];
  stderr: string[];
  portsIn(cwd: string): CliPorts;
};

export const startRealRuntime = async (overrides: Parameters<typeof startService>[0] = {}): Promise<RealRuntime> => {
  const service = await startService(overrides);
  const { layout } = service;
  const paths = momongaPaths(layout.home);
  await ensureMomongaDirs(paths);
  const published = await publishCurrentGeneration(paths, {
    generation: 1,
    version: REAL_RUNTIME_VERSION,
    sockets: { runtime: layout.socketPath, gateway: path.join(layout.runDir, 'g.sock'), supervisor: path.join(layout.runDir, 's.sock') },
  });
  if (published !== 'published') throw new Error(`the generation of the test runtime was not published: ${published}`);
  const client = createRuntimeClient({ resolveSocket: async () => layout.socketPath, clock: { now: () => service.clock.now(), sleep: async () => undefined } });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const portsIn = (cwd: string): CliPorts =>
    terminalPorts({
      version: REAL_RUNTIME_VERSION,
      home: layout.home,
      cwd,
      env: {},
      platform: process.platform,
      interrupt: new AbortController().signal,
      clock: { now: () => service.clock.now(), sleep: async () => undefined },
      random: () => 0.5,
      stdout: { write: (text: string) => (stdout.push(text), true) },
      stderr: { write: (text: string) => (stderr.push(text), true) },
    } as unknown as CliPorts);
  return { service, paths, client, ports: portsIn(layout.project), stdout, stderr, portsIn };
};
