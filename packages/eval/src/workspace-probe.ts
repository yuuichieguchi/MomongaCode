import path from 'node:path';
import { groupSignalsOf, sha256Hex } from '@momonga/foundation';
import type { ProcessGroupPort, Timing } from '@momonga/foundation';
import type { WorkspaceFiles } from './files.ts';
import { filesUnder } from './oracle-grade.ts';
import type { WorkspaceProbe } from './oracle-grade.ts';

export type SandboxedProbeRun = { pgid: number; exited: Promise<{ code: number | null }> };

export type CommandSandbox = { start(command: string, workspace: string, env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<SandboxedProbeRun> };

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
  const stop = new AbortController();
  const started = await ports.sandbox.start(command, cwd, ports.env, stop.signal);
  let timedOut = false;
  let signalled: Promise<unknown> = Promise.resolve();
  const timer = ports.timing.setTimeout(() => {
    timedOut = true;
    signalled = ports.groups.signal(started.pgid, strongestSignal(ports.groups), { signal: undefined });
    stop.abort();
  }, timeoutMs);
  try {
    const { code } = await started.exited;
    await signalled;
    return { exitCode: timedOut ? null : code, timedOut };
  } finally {
    ports.timing.clearTimeout(timer);
  }
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
