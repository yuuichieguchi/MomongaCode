import type { CommandRunner } from './command-runner.ts';
import type { Timing } from '../timing.ts';
import { abandoned } from './abandoned.ts';
import { failureOfError, probeFailed } from './inspector-types.ts';
import { withListedState } from './marker-state.ts';
import type { ProbeFailure, ProbeResult, ProcessInspector } from './inspector-types.ts';
import type { KeptGroupControl } from './windows-kept-groups.ts';
import { parsePidList, parseStartTime } from './windows-parsers.ts';
import { holdersScript, powershellArgs, powershellPath, startTimeScript } from './windows-scripts.ts';

export const POWERSHELL_CALL_BOUND_MS = 10_000;

export type WindowsInspectorPorts = {
  run: CommandRunner;
  timing: Pick<Timing, 'setTimeout' | 'clearTimeout'>;
  env: Readonly<Record<string, string | undefined>>;
  groups: Pick<KeptGroupControl, 'members' | 'leads'>;
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

const boundedCall = async <T>(work: (signal: AbortSignal) => Promise<T>, timing: Pick<Timing, 'setTimeout' | 'clearTimeout'>, signal: AbortSignal): Promise<T> => {
  const bound = new AbortController();
  const expire = (): void => bound.abort(Object.assign(new Error(`powershell did not answer within ${POWERSHELL_CALL_BOUND_MS} ms`), { killed: true }));
  const timer = timing.setTimeout(expire, POWERSHELL_CALL_BOUND_MS);
  const leave = (): void => bound.abort(signal.reason);
  signal.addEventListener('abort', leave, { once: true });
  try {
    return await abandoned(work(bound.signal), bound.signal);
  } finally {
    timing.clearTimeout(timer);
    signal.removeEventListener('abort', leave);
  }
};

export const createWindowsInspector = ({ run, timing, env, groups, alive }: WindowsInspectorPorts): ProcessInspector => {
  const execute = async (script: string, signal: AbortSignal): Promise<string> => {
    const result = await boundedCall((bounded) => run(powershellPath(env), powershellArgs(script), { env: probeEnv(env), signal: bounded }), timing, signal);
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
        const jobs = await Promise.all(
          candidateGroups.map(async (candidate) => {
            const answer = await groups.members(candidate, { signal });
            return { candidate, members: new Set(answer.kind === 'members' ? answer.pids : []), leader: groups.leads(candidate) };
          }),
        );
        const value = new Map<number, number>();
        for (const pid of pids) {
          const job = jobs.find(({ candidate, members, leader }) => members.has(pid) || (candidate === pid && leader && alive(pid)));
          if (job !== undefined) value.set(pid, job.candidate);
          else if (alive(pid) && !candidateGroups.includes(pid)) value.set(pid, pid);
        }
        return { kind: 'value', value };
      }),
  });
};
