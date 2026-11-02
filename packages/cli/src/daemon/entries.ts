import type { EntryIo } from '@momonga/foundation';

export const runGateway = async (io: EntryIo): Promise<number> => {
  const { runGatewayEntry } = await import('@momonga/gateway');
  return runGatewayEntry(io);
};

export const runRuntime = async (io: EntryIo): Promise<number> => {
  const { runRuntimeEntry } = await import('@momonga/runtime/entry');
  return runRuntimeEntry(io);
};
