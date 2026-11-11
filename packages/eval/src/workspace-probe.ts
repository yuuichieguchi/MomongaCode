import path from 'node:path';
import { groupSignalsOf, launchGroupLeader, sha256Hex } from '@momonga/foundation';
import type { LaunchProtection, ProcessGroupPort, Timing } from '@momonga/foundation';
import type { WorkspaceFiles } from './files.ts';
import { filesUnder } from './oracle-grade.ts';
import type { WorkspaceProbe } from './oracle-grade.ts';

export type SandboxedProbeCommand = { file: string; args: readonly string[]; protection: LaunchProtection };

export type CommandSandbox = { commandOf(command: string, workspace: string): Promise<SandboxedProbeCommand> };

export type WorkspaceProbePorts = {
  env: Readonly<Record<string, string>>;
  sandbox: CommandSandbox;
  files: WorkspaceFiles;
  timing: Pick<Timing, 'setTimeout' | 'clearTimeout'>;
  groups: ProcessGroupPort;
};

type ProbeOutcome = { exitCode: number | null; timedOut: boolean };

const ABSENT_ENTRY = 'absent';

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const entryHashOf = async (files: WorkspaceFiles, file: string): Promise<string> => {
  const stat = await files.lstat(file).then(
    (found) => found,
    (error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    },
  );
  if (stat === undefined) return ABSENT_ENTRY;
  if (stat.isFile()) return `file:${sha256Hex(await files.readFile(file))}`;
  if (stat.isSymbolicLink()) return `link:${sha256Hex(await files.readlink(file))}`;
  if (stat.isDirectory()) return 'directory';
  return 'other';
};

const strongestSignal = (groups: ProcessGroupPort): NodeJS.Signals => {
  const signals = groupSignalsOf(groups);
  return signals[signals.length - 1] ?? signals[0];
};

const runInGroup = async (ports: WorkspaceProbePorts, command: string, timeoutMs: number, cwd: string): Promise<ProbeOutcome> => {
  const sandboxed = await ports.sandbox.commandOf(command, cwd);
  return new Promise((resolve, reject) => {
    const launched = launchGroupLeader({ file: sandboxed.file, args: sandboxed.args, cwd, env: ports.env, stdio: ['ignore', 'ignore', 'ignore'], port: ports.groups, protection: sandboxed.protection });
    let timedOut = false;
    const timer = ports.timing.setTimeout(() => {
      timedOut = true;
      if (launched.pgid !== undefined) ports.groups.signal(launched.pgid, strongestSignal(ports.groups), { signal: undefined }).catch(reject);
    }, timeoutMs);
    const failed = (error: Error): void => {
      ports.timing.clearTimeout(timer);
      reject(error);
    };
    launched.child.once('error', failed);
    launched.onExit(({ code }) => {
      ports.timing.clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut });
    }, failed);
  });
};

export const createWorkspaceProbe = (ports: WorkspaceProbePorts): WorkspaceProbe => ({
  run: (command, timeoutMs, cwd) => runInGroup(ports, command, timeoutMs, cwd),
  digest: async (cwd, paths) => {
    const entries: string[] = [];
    for (const relative of [...paths].sort()) entries.push(`${relative}\0${await entryHashOf(ports.files, path.join(cwd, relative))}`);
    return sha256Hex(entries.join('\n'));
  },
  changedPaths: async (cwd, baseDir) => {
    const all = [...new Set([...(await filesUnder(ports.files, cwd, '')), ...(await filesUnder(ports.files, baseDir, ''))])].sort();
    const changed: string[] = [];
    for (const relative of all) {
      const [now, before] = await Promise.all([entryHashOf(ports.files, path.join(cwd, relative)), entryHashOf(ports.files, path.join(baseDir, relative))]);
      if (now !== before) changed.push(relative);
    }
    return changed;
  },
});
