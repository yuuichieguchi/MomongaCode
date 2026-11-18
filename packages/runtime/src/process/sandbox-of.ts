import path from 'node:path';
import { ConfigError, SANDBOX_LAUNCHERS_LOOKED_FOR } from '@momonga/config';
import { helperCommandLine, nodeFileSystem } from '@momonga/foundation';
import type { ChildProtection, HelperSelf, KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH, NETWORK_RELAY_HELPER, SANDBOX_KILL_GRACE_MS, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, createUnsandboxed, heldMountPoints, probeBubblewrap } from '@momonga/sandbox';
import type { Sandbox } from '@momonga/sandbox';
import { ShellNotFoundError, resolveBashPath } from '@momonga/tools';
import type { ShellHost } from '@momonga/tools';
import type { SandboxKind } from './sandbox-kind.ts';

const PLACEHOLDER_JOURNAL_DIRECTORY = 'placeholders';

export const placeholderJournalDirectoryOf = (paths: Pick<MomongaPaths, 'state'>): string => path.join(paths.state, PLACEHOLDER_JOURNAL_DIRECTORY);

export type SandboxOfHost = {
  platform: NodeJS.Platform;
  paths: MomongaPaths;
  env: Readonly<Record<string, string | undefined>>;
  shellHost: ShellHost;
  kernelLock: KernelLockMechanism;
  journalDirectory: string;
  noneProtection: ChildProtection;
  warn(text: string): void;
  sandboxExecPath?: string;
  socketGuard?: () => Promise<string>;
  helperSelf?: HelperSelf;
};

export const createSandboxOf =
  (host: SandboxOfHost) =>
  async (kind: SandboxKind, deriveSignal: AbortSignal): Promise<Sandbox> => {
    const { platform, paths, helperSelf } = host;
    if (kind === 'none') {
      const unsandboxed = createUnsandboxed({ killGraceMs: SANDBOX_KILL_GRACE_MS, protection: host.noneProtection, platform });
      host.warn('sandbox is none: Bash asks before every command');
      if (host.noneProtection.kind === 'unprotected') host.warn(host.noneProtection.reason);
      return unsandboxed;
    }
    const launcherPath = host.sandboxExecPath ?? (kind === 'seatbelt' ? DEFAULT_SANDBOX_EXEC_PATH : DEFAULT_BWRAP_PATH);
    const launcherName = kind === 'seatbelt' ? 'sandbox-exec' : 'bwrap';
    try {
      await nodeFileSystem.access(launcherPath, 'execute');
    } catch (error) {
      throw new ConfigError(
        `${launcherName} is not available at ${launcherPath}; the sandbox launchers looked for are ${SANDBOX_LAUNCHERS_LOOKED_FOR}; set "sandbox": "none" in ${paths.settingsFile} to run without a sandbox (Bash will then ask before every command)`,
        { cause: error },
      );
    }
    if (kind === 'bubblewrap') {
      let shell: string;
      try {
        shell = await resolveBashPath(host.shellHost.platform, { isExecutable: host.shellHost.isExecutable, env: host.env });
      } catch (error) {
        if (!(error instanceof ShellNotFoundError)) throw error;
        throw new ConfigError(error.message, { cause: error });
      }
      const probe = await probeBubblewrap(launcherPath, shell, { signal: deriveSignal });
      if (!probe.ok) {
        throw new ConfigError(
          `bwrap at ${launcherPath} cannot create a sandbox on this host: ${probe.stderr}; set "sandbox": "none" in ${paths.settingsFile} to run without a sandbox (Bash will then ask before every command)`,
        );
      }
      return createBubblewrapSandbox({
        bwrapPath: launcherPath,
        tmpRoot: paths.tmp.spawn,
        lock: host.kernelLock,
        killGraceMs: SANDBOX_KILL_GRACE_MS,
        journal: createPlaceholderJournal(host.journalDirectory),
        holders: () => heldMountPoints(),
        ...(host.socketGuard === undefined ? {} : { socketGuard: host.socketGuard }),
        ...(helperSelf === undefined ? {} : { relay: () => helperCommandLine(helperSelf, NETWORK_RELAY_HELPER, []) }),
      });
    }
    return createSeatbeltSandbox({ sandboxExecPath: launcherPath, tmpRoot: paths.tmp.spawn, lock: host.kernelLock, killGraceMs: SANDBOX_KILL_GRACE_MS });
  };
