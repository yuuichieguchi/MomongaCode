import { nodeEntryIo } from '@momonga/foundation';
import { runGatewayEntry } from '@momonga/gateway';
import { runRuntimeEntry } from '@momonga/runtime';

export const roleMain = (argv: readonly string[]): Promise<number> => {
  const [role, version, ...entryArgv] = argv;
  if (version === undefined) throw new Error('role-main needs the role and the version it reports as its first two arguments');
  const io = { ...nodeEntryIo(), argv: entryArgv };
  if (role === 'gateway') return runGatewayEntry(io, { version });
  if (role === 'runtime') return runRuntimeEntry(io, { version });
  throw new Error(`role-main: unknown role ${role}`);
};

if (import.meta.main) void roleMain(process.argv.slice(2));
