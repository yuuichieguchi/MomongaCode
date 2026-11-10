import type { ChildRole } from '../client/supervisor-client.ts';
import type { SelfExecutable } from '../ports.ts';

export const SUPERVISED_ROLE_COMMANDS = { gateway: '__gateway', runtime: '__runtime' } as const satisfies Record<ChildRole, string>;

export const INTERNAL_COMMANDS = { supervise: '__supervise', updateCheck: '__update-check', ...SUPERVISED_ROLE_COMMANDS } as const;

export type MomongaLaunch = { readonly args: readonly string[]; readonly choosesSecretStoreFromPath: boolean };

export const MOMONGA_LAUNCHES = {
  supervise: { args: [INTERNAL_COMMANDS.supervise], choosesSecretStoreFromPath: true },
  updateCheck: { args: [INTERNAL_COMMANDS.updateCheck], choosesSecretStoreFromPath: true },
  gateway: { args: [INTERNAL_COMMANDS.gateway], choosesSecretStoreFromPath: false },
  runtime: { args: [INTERNAL_COMMANDS.runtime], choosesSecretStoreFromPath: false },
  reportVersion: { args: ['--version'], choosesSecretStoreFromPath: false },
  startDaemon: { args: ['daemon', 'start'], choosesSecretStoreFromPath: true },
} as const satisfies Record<keyof typeof INTERNAL_COMMANDS | 'reportVersion' | 'startDaemon', MomongaLaunch>;

export type SelfInvocation = { command: string; args: readonly string[] };

export const selfInvocation = (self: SelfExecutable, subcommand: string, flags: readonly string[] = []): SelfInvocation =>
  self.kind === 'single-binary'
    ? { command: self.execPath, args: [subcommand, ...flags] }
    : { command: self.execPath, args: [self.script, subcommand, ...flags] };

export const selfLauncher =
  (self: SelfExecutable) =>
  (role: ChildRole): SelfInvocation =>
    selfInvocation(self, SUPERVISED_ROLE_COMMANDS[role]);

export const superviseFlags = (home: string, generation: number, lifelineFd: number | undefined): string[] => [
  `--home=${home}`,
  `--generation=${generation}`,
  '--log-target=file',
  ...(lifelineFd === undefined ? [] : [`--lifeline-fd=${lifelineFd}`]),
];

export const superviseInvocation = (self: SelfExecutable, home: string, generation: number, lifelineFd: number | undefined): SelfInvocation => {
  const [subcommand, ...leading] = MOMONGA_LAUNCHES.supervise.args;
  return selfInvocation(self, subcommand, [...leading, ...superviseFlags(home, generation, lifelineFd)]);
};
