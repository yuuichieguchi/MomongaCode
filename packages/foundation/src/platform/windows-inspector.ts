import type { CommandRunner, SyncCommandRunner } from './command-runner.ts';
import type { ProcessInspector } from './inspector-types.ts';
import { groupMembers, groupOfPid, parsePidList, parseProcessTable, parseStartTimeMs } from './windows-parsers.ts';
import { PROCESS_TABLE_SCRIPT, holdersScript, powershellArgs, powershellPath, startTimeScript, taskkillPath } from './windows-scripts.ts';

export const WINDOWS_PROBE_TIMEOUT_MS = 10_000;

export type WindowsInspectorPorts = { run: CommandRunner; env: Readonly<Record<string, string | undefined>>; timeoutMs?: number };

const probeEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

export const createWindowsPowerShell = ({ run, env, timeoutMs = WINDOWS_PROBE_TIMEOUT_MS }: WindowsInspectorPorts) => {
  const execute = async (script: string): Promise<string> => {
    const result = await run(powershellPath(env), powershellArgs(script), { env: probeEnv(env), timeoutMs });
    if (result.exitCode !== 0) throw new Error(`powershell exited with ${result.exitCode}: ${result.stderr.trim()}`);
    return result.stdout;
  };
  return execute;
};

export const createWindowsInspector = (ports: WindowsInspectorPorts): ProcessInspector => {
  const execute = createWindowsPowerShell(ports);
  return {
    startTimeOf: async (pid) => parseStartTimeMs(await execute(startTimeScript(pid))),
    holdersOf: async (marker) => parsePidList(await execute(holdersScript(marker))),
    groupsOf: async (pids, candidateGroups) => {
      const rows = parseProcessTable(await execute(PROCESS_TABLE_SCRIPT));
      const alive = new Set(rows.map((row) => row.pid));
      return new Map(pids.filter((pid) => alive.has(pid)).map((pid) => [pid, groupOfPid(rows, pid, candidateGroups)]));
    },
  };
};

export type WindowsGroupPorts = { run: SyncCommandRunner; env: Readonly<Record<string, string | undefined>>; timeoutMs?: number };

export const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

export type GroupControl = {
  members(root: number): number[];
  terminate(root: number): void;
};

export const createWindowsGroupControl = ({ run, env, timeoutMs = WINDOWS_PROBE_TIMEOUT_MS }: WindowsGroupPorts): GroupControl => {
  const members = (root: number): number[] => {
    const result = run(powershellPath(env), powershellArgs(PROCESS_TABLE_SCRIPT), { env: probeEnv(env), timeoutMs });
    if (result.exitCode !== 0) throw new Error(`powershell exited with ${result.exitCode}: ${result.stderr.trim()}`);
    const rows = parseProcessTable(result.stdout);
    return groupMembers(rows, root);
  };
  return {
    members,
    terminate: (root) => {
      const targets = members(root);
      if (targets.length === 0) return;
      const result = run(taskkillPath(env), ['/F', ...targets.flatMap((pid) => ['/PID', String(pid)])], { env: probeEnv(env), timeoutMs });
      if (result.exitCode !== 0 && result.exitCode !== TASKKILL_NOT_FOUND_EXIT_CODE) {
        throw new Error(`taskkill exited with ${result.exitCode}: ${result.stderr.trim()}`);
      }
    },
  };
};
