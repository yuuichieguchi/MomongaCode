import type { CommandRunner } from './command-runner.ts';
import { failureOfError, probeFailed } from './inspector-types.ts';
import { withListedState } from './marker-state.ts';
import type { GroupProbeOptions } from './group-port.ts';
import type { ProbeFailure, ProbeResult, ProcessInspector } from './inspector-types.ts';
import type { GroupLedger } from './windows-parsers.ts';
import { groupMembers, groupOfPid, parsePidList, parseProcessTable, parseStartTime } from './windows-parsers.ts';
import { PROCESS_TABLE_SCRIPT, holdersScript, powershellArgs, powershellPath, startTimeScript, taskkillPath } from './windows-scripts.ts';

export type WindowsInspectorPorts = { run: CommandRunner; env: Readonly<Record<string, string | undefined>> };

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

export const createWindowsInspector = ({ run, env }: WindowsInspectorPorts): ProcessInspector => {
  const execute = async (script: string, signal: AbortSignal): Promise<string> => {
    const result = await run(powershellPath(env), powershellArgs(script), { env: probeEnv(env), signal });
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
  return withListedState({
    startTimeOf: (pid, { signal }) =>
      guarded(async () => {
        const output = await execute(startTimeScript(pid), signal);
        const startedAt = parseOutput(() => parseStartTime(output));
        return startedAt === undefined ? { kind: 'gone' } : { kind: 'value', value: startedAt };
      }),
    holdersOf: (marker, { signal }) =>
      guarded(async () => {
        const output = await execute(holdersScript(marker), signal);
        return { kind: 'value', value: parseOutput(() => parsePidList(output)) };
      }),
    groupsOf: (pids, candidateGroups, { signal }) =>
      guarded(async () => {
        const output = await execute(PROCESS_TABLE_SCRIPT, signal);
        const rows = parseOutput(() => parseProcessTable(output));
        const alive = new Set(rows.map((row) => row.pid));
        return { kind: 'value', value: new Map(pids.filter((pid) => alive.has(pid)).map((pid) => [pid, groupOfPid(rows, pid, candidateGroups)])) };
      }),
  });
};

export type WindowsGroupPorts = { run: CommandRunner; env: Readonly<Record<string, string | undefined>> };

export const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

export type GroupControl = {
  members(root: number, options: GroupProbeOptions): Promise<number[]>;
  terminate(root: number, options: GroupProbeOptions): Promise<void>;
};

export const createWindowsGroupControl = ({ run, env }: WindowsGroupPorts): GroupControl => {
  const ledgers = new Map<number, GroupLedger>();
  const members = async (root: number, options: GroupProbeOptions): Promise<number[]> => {
    const result = await run(powershellPath(env), powershellArgs(PROCESS_TABLE_SCRIPT), { env: probeEnv(env), signal: options.signal });
    if (result.exitCode !== 0) throw new Error(`powershell exited with ${result.exitCode}: ${result.stderr.trim()}`);
    const rows = parseProcessTable(result.stdout);
    const ledger = ledgers.get(root) ?? new Map();
    ledgers.set(root, ledger);
    const found = groupMembers(rows, root, ledger);
    if (found.length === 0) ledgers.delete(root);
    return found;
  };
  return {
    members,
    terminate: async (root, options) => {
      const targets = await members(root, options);
      if (targets.length === 0) return;
      const result = await run(taskkillPath(env), ['/F', ...targets.flatMap((pid) => ['/PID', String(pid)])], { env: probeEnv(env), signal: options.signal });
      if (result.exitCode !== 0 && result.exitCode !== TASKKILL_NOT_FOUND_EXIT_CODE) {
        throw new Error(`taskkill exited with ${result.exitCode}: ${result.stderr.trim()}`);
      }
    },
  };
};
