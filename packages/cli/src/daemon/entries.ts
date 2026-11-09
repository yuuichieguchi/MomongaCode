import type { EntryIo } from '@momonga/foundation';
import type { SelfExecutable } from '../ports.ts';
import { embeddedRipgrepSource } from '../ripgrep/host.ts';
import { selfLauncher } from './launcher.ts';
import { runSupervise } from './supervise.ts';

export type DaemonEntries = {
  supervise(io: EntryIo): Promise<number>;
  gateway(io: EntryIo): Promise<number>;
  runtime(io: EntryIo): Promise<number>;
};

export const daemonEntries = (self: SelfExecutable, version: string): DaemonEntries => ({
  supervise: (io) => runSupervise(io, { launcher: selfLauncher(self), deps: { version } }),
  gateway: async (io) => {
    const { runGatewayEntry } = await import('@momonga/gateway');
    return runGatewayEntry(io, { version });
  },
  runtime: async (io) => {
    const entry = await import('@momonga/runtime/entry');
    const { runRuntimeEntry } = entry;
    const bundledRipgrep = embeddedRipgrepSource(entry);
    return runRuntimeEntry(io, { version, ...(bundledRipgrep === undefined ? {} : { bundledRipgrep }) });
  },
});
