import type { CommandRunner } from './command-runner.ts';
import { failureOfError, probeFailed } from './inspector-types.ts';
import { withListedState } from './marker-state.ts';
import type { ProbeFailure, ProbeResult, ProcessInspector } from './inspector-types.ts';
import type { KeptGroupControl } from './windows-kept-groups.ts';
import { parsePidList, parseStartTime } from './windows-parsers.ts';
import { holdersScript, powershellArgs, powershellPath, startTimeScript } from './windows-scripts.ts';

export type WindowsInspectorPorts = {
  run: CommandRunner;
  env: Readonly<Record<string, string | undefined>>;
  groups: Pick<KeptGroupControl, 'members'>;
  alive(pid: number): boolean;
};

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

export const createWindowsInspector = ({ run, env, groups, alive }: WindowsInspectorPorts): ProcessInspector => {
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
        const jobs = await Promise.all(candidateGroups.map(async (candidate) => ({ candidate, members: new Set(await groups.members(candidate, { signal })) })));
        const value = new Map<number, number>();
        for (const pid of pids) {
          const job = jobs.find(({ candidate, members }) => members.has(pid) || (candidate === pid && alive(pid)));
          if (job !== undefined) value.set(pid, job.candidate);
          else if (alive(pid)) value.set(pid, pid);
        }
        return { kind: 'value', value };
      }),
  });
};
