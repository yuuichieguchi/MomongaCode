import type { EntryIo } from '@momonga/foundation';
import type { DaemonEntries } from './daemon/entries.ts';
import type { CliPorts } from './ports.ts';

export type ProgramDeps = {
  ports: CliPorts;
  interrupt: AbortSignal;
  entryIo(args: readonly string[]): EntryIo;
  entries: DaemonEntries;
  complete(code: number): void;
};
