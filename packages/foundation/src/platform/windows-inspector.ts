import type { CommandRunner, SyncCommandRunner } from './command-runner.ts';
import { failureOfError, probeFailed } from './inspector-types.ts';
import type { ProbeFailure, ProbeResult, ProcessInspector } from './inspector-types.ts';
import { groupMembers, groupOfPid, parsePidList, parseProcessTable, parseStartTimeMs } from './windows-parsers.ts';
import { PROCESS_TABLE_SCRIPT, holdersScript, powershellArgs, powershellPath, startTimeScript, taskkillPath } from './windows-scripts.ts';

export const WINDOWS_PROBE_TIMEOUT_MS = 10_000;

export type WindowsInspectorPorts = { run: CommandRunner; env: Readonly<Record<string, string | undefined>>; timeoutMs?: number };

const probeEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));

class PowerShellExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

class PowerShellOutputUnparseable extends Error {}

const parseOutput = <T>(parse: () => T): T => {
  try {
    return parse();
  } catch (error) {
    throw new PowerShellOutputUnparseable((error as Error).message);
  }
};

const failureOf = (error: unknown): ProbeFailure => {
  if (error instanceof PowerShellExit) return probeFailed({ kind: 'exit', exitCode: error.exitCode, detail: error.message });
  if (error instanceof PowerShellOutputUnparseable) return probeFailed({ kind: 'unparseable', detail: error.message });
  return failureOfError(error);
};

export const createWindowsInspector = ({ run, env, timeoutMs = WINDOWS_PROBE_TIMEOUT_MS }: WindowsInspectorPorts): ProcessInspector => {
  const execute = async (script: string): Promise<string> => {
    const result = await run(powershellPath(env), powershellArgs(script), { env: probeEnv(env), timeoutMs });
    if (result.exitCode !== 0) throw new PowerShellExit(result.exitCode, `powershell exited with ${result.exitCode}: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const guarded = async <T>(read: () => Promise<ProbeResult<T>>): Promise<ProbeResult<T>> => {
    try {
      return await read();
    } catch (error) {
      return failureOf(error);
    }
  };
  return {
    startTimeOf: (pid) =>
      guarded(async () => {
        const output = await execute(startTimeScript(pid));
        const startedAt = parseOutput(() => parseStartTimeMs(output));
        return startedAt === undefined ? { kind: 'gone' } : { kind: 'value', value: startedAt };
      }),
    holdersOf: (marker) =>
      guarded(async () => {
        const output = await execute(holdersScript(marker));
        return { kind: 'value', value: parseOutput(() => parsePidList(output)) };
      }),
    groupsOf: (pids, candidateGroups) =>
      guarded(async () => {
        const output = await execute(PROCESS_TABLE_SCRIPT);
        const rows = parseOutput(() => parseProcessTable(output));
        const alive = new Set(rows.map((row) => row.pid));
        return { kind: 'value', value: new Map(pids.filter((pid) => alive.has(pid)).map((pid) => [pid, groupOfPid(rows, pid, candidateGroups)])) };
      }),
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
