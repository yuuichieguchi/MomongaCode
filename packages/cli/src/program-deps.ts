import type { EntryIo } from '@momonga/foundation';
import type { DaemonEntries } from './daemon/entries.ts';
import type { CliPorts } from './ports.ts';
import type { UpdateWiring } from './update/background.ts';
import type { PolicyVerifyHost } from './verify/host.ts';

export type ProgramDeps = {
  ports: CliPorts;
  interrupt: AbortSignal;
  entryIo(args: readonly string[]): EntryIo;
  entries: DaemonEntries;
  update(): UpdateWiring | Promise<UpdateWiring>;
  policyVerify(): PolicyVerifyHost | Promise<PolicyVerifyHost>;
  complete(code: number): void;
};
