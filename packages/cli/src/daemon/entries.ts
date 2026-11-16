import type { EntryIo, FileSystem } from '@momonga/foundation';
import type { SelfExecutable, SpawnDetached } from '../ports.ts';
import { embeddedRipgrepSource } from '../ripgrep/host.ts';
import { hostSocketGuardSource } from '../socket-guard/host.ts';
import { embeddedRuleSolver } from '../verify/host.ts';
import { selfLauncher } from './launcher.ts';
import { runSupervise } from './supervise.ts';

export type DaemonEntries = {
  supervise(io: EntryIo): Promise<number>;
  gateway(io: EntryIo): Promise<number>;
  runtime(io: EntryIo): Promise<number>;
};

export const daemonEntries = (self: SelfExecutable, version: string, spawnDetached: SpawnDetached, fileSystem: FileSystem): DaemonEntries => ({
  supervise: (io) => runSupervise(io, { launcher: selfLauncher(self), deps: { version }, successor: { self, spawnDetached } }),
  gateway: async (io) => {
    const { runGatewayEntry } = await import('@momonga/gateway');
    return runGatewayEntry(io, { version });
  },
  runtime: async (io) => {
    const entry = await import('@momonga/runtime/entry');
    const { runRuntimeEntry } = entry;
    const bundledRipgrep = embeddedRipgrepSource(entry);
    const ruleSolver = embeddedRuleSolver();
    const socketGuard = hostSocketGuardSource();
    return runRuntimeEntry(io, {
      version,
      helperSelf: self.kind === 'single-binary' ? { execPath: self.execPath } : { execPath: self.execPath, script: self.script },
      fileSystem,
      ...(bundledRipgrep === undefined ? {} : { bundledRipgrep }),
      ...(ruleSolver === undefined ? {} : { ruleSolver }),
      ...(socketGuard === undefined ? {} : { socketGuard }),
    });
  },
});
