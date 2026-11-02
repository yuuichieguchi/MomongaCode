import type { EntryIo } from '@momonga/foundation';
import type { SelfExecutable } from '../ports.ts';
import { selfLauncher } from './launcher.ts';
import { runSupervise } from './supervise.ts';

export type DaemonEntries = {
  supervise(io: EntryIo): Promise<number>;
  gateway(io: EntryIo): Promise<number>;
  runtime(io: EntryIo): Promise<number>;
};

export const daemonEntries = (self: SelfExecutable): DaemonEntries => ({
  supervise: (io) => runSupervise(io, { launcher: selfLauncher(self) }),
  gateway: async (io) => {
    const { runGatewayEntry } = await import('@momonga/gateway');
    return runGatewayEntry(io);
  },
  runtime: async (io) => {
    const { runRuntimeEntry } = await import('@momonga/runtime/entry');
    return runRuntimeEntry(io);
  },
});
