import { momongaLayout, protectedAreasOf } from '@momonga/foundation';
import type { ChildProtection, LayoutEnvironment } from '@momonga/foundation';
import { planProtection } from './bubblewrap.ts';
import { buildProtectionProfile, paramArgsOf } from './profile.ts';

export type SandboxSetting = 'none' | 'seatbelt' | 'bubblewrap';

export type ChildProtectionInput = {
  sandbox: SandboxSetting;
  home: string;
  platform: NodeJS.Platform;
  env: LayoutEnvironment;
  bubblewrap: boolean;
};

type HomeLauncher = 'seatbelt' | 'bubblewrap';

const HOME_LAUNCHERS: Readonly<Partial<Record<NodeJS.Platform, HomeLauncher>>> = { darwin: 'seatbelt', linux: 'bubblewrap' };

const unprotectedReason = (root: string, launcher: HomeLauncher | undefined): string =>
  launcher === 'bubblewrap'
    ? `With sandbox none, commands can read and change the product's home at ${root} (its sockets, credentials and stores), because bubblewrap is not installed: install bubblewrap (bwrap) to protect it.`
    : `With sandbox none, commands can read and change the product's home at ${root} (its sockets, credentials and stores), because this platform has no sandbox the product can use.`;

export function childProtectionFor(input: ChildProtectionInput): ChildProtection {
  const layout = momongaLayout(input.home, input.platform, input.env);
  const launcher = HOME_LAUNCHERS[input.platform];
  const hasPlatformSandbox = launcher === 'seatbelt' || (launcher === 'bubblewrap' && input.bubblewrap);
  if (input.sandbox === 'none' && !hasPlatformSandbox) return { kind: 'unprotected', reason: unprotectedReason(layout.root, launcher) };
  return { kind: 'home-denied', home: input.home, denied: protectedAreasOf(layout) };
}

export type ProtectionCommandInput = {
  platform: NodeJS.Platform;
  argv: readonly string[];
  scratch: readonly string[];
  readable: readonly string[];
  sandboxExecPath: string;
  bwrapPath: string;
};

export type ProtectionCommand = { file: string; args: string[] };

export function protectionCommandOf(protection: ChildProtection, input: ProtectionCommandInput): ProtectionCommand {
  const [file, ...args] = input.argv;
  if (file === undefined) throw new Error('argv must not be empty');
  if (protection.kind === 'unprotected') return { file, args };
  const launcher = HOME_LAUNCHERS[input.platform];
  if (launcher === undefined) throw new Error(`the home cannot be denied to a child on ${input.platform}`);
  if (launcher === 'seatbelt') {
    const { profile, params } = buildProtectionProfile(protection.denied, input.scratch, input.readable);
    return { file: input.sandboxExecPath, args: ['-p', profile, ...paramArgsOf(params), '--', ...input.argv] };
  }
  return { file: input.bwrapPath, args: [...planProtection(protection.denied, input.scratch, input.readable), '--', ...input.argv] };
}

const ABSENT_LAUNCHER_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'ENOTDIR']);

export async function bubblewrapPresent(bwrapPath: string, access: (file: string) => Promise<void>): Promise<boolean> {
  try {
    await access(bwrapPath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && ABSENT_LAUNCHER_CODES.has(error.code)) return false;
    throw error;
  }
}
