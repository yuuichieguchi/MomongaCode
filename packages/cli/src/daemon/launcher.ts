import type { ChildRole } from '../client/supervisor-client.ts';
import type { SelfExecutable } from '../ports.ts';

export const SUPERVISED_ROLE_COMMANDS = { gateway: '__gateway', runtime: '__runtime' } as const satisfies Record<ChildRole, string>;

export const INTERNAL_COMMANDS = { supervise: '__supervise', updateCheck: '__update-check', ...SUPERVISED_ROLE_COMMANDS } as const;

export type SelfInvocation = { command: string; args: readonly string[] };

export const selfInvocation = (self: SelfExecutable, subcommand: string, flags: readonly string[] = []): SelfInvocation =>
  self.kind === 'single-binary'
    ? { command: self.execPath, args: [subcommand, ...flags] }
    : { command: self.execPath, args: [self.script, subcommand, ...flags] };

export const selfLauncher =
  (self: SelfExecutable) =>
  (role: ChildRole): SelfInvocation =>
    selfInvocation(self, SUPERVISED_ROLE_COMMANDS[role]);
