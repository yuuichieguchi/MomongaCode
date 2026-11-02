import type { CommandResult, CommandRunner } from './command-runner.ts';
import { failureOfError, probeFailed } from './inspector-types.ts';
import type { ProbeFailure, ProcessInspector } from './inspector-types.ts';

export const PS_BINARY = '/bin/ps';
export const LSOF_BINARY = '/usr/sbin/lsof';

const ROW_FORMAT = /^\s*(\d+)\s+(\d+)\s*$/;
const NO_MATCH_EXIT_CODE = 1;

export const parseLstart = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const startedAt = Date.parse(`${trimmed} GMT`);
  return Number.isNaN(startedAt) ? undefined : startedAt;
};

const contentLines = (text: string): string[] => text.split('\n').filter((line) => line.trim() !== '');

export const parsePidList = (text: string): number[] | undefined => {
  const lines = contentLines(text);
  return lines.every((line) => /^\d+$/.test(line.trim())) ? lines.map((line) => Number(line.trim())) : undefined;
};

export const parsePidGroupRows = (text: string): Map<number, number> | undefined => {
  const rows: Array<[number, number]> = [];
  for (const line of contentLines(text)) {
    const match = ROW_FORMAT.exec(line);
    if (match === null) return undefined;
    rows.push([Number(match[1]), Number(match[2])]);
  }
  return new Map(rows);
};

export type DarwinInspectorPorts = { run: CommandRunner; startTimeoutMs: number; listTimeoutMs?: number };

const firstLine = (text: string): string => text.trim().split('\n', 1)[0] ?? '';

const exitFailure = (tool: string, exitCode: number, stderr: string): ProbeFailure =>
  probeFailed({ kind: 'exit', exitCode, detail: `${tool} exited with ${exitCode}: ${firstLine(stderr)}` });

const unparseable = (tool: string, output: string): ProbeFailure => probeFailed({ kind: 'unparseable', detail: `${tool} printed ${JSON.stringify(firstLine(output))}` });

const markerMissing = (marker: string, stderr: string): boolean => firstLine(stderr) === `lsof: status error on ${marker}: No such file or directory`;

const attempt = async (operation: () => Promise<CommandResult>): Promise<CommandResult | ProbeFailure> => {
  try {
    return await operation();
  } catch (error) {
    return failureOfError(error);
  }
};

const isFailure = (outcome: CommandResult | ProbeFailure): outcome is ProbeFailure => 'kind' in outcome;

export const createDarwinInspector = ({ run, startTimeoutMs, listTimeoutMs = startTimeoutMs }: DarwinInspectorPorts): ProcessInspector => {
  const env = { LC_ALL: 'C' };
  return {
    startTimeOf: async (pid) => {
      const result = await attempt(() => run(PS_BINARY, ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C', TZ: 'UTC' }, timeoutMs: startTimeoutMs }));
      if (isFailure(result)) return result;
      if (result.exitCode === NO_MATCH_EXIT_CODE && result.stdout.trim() === '' && result.stderr.trim() === '') return { kind: 'gone' };
      if (result.exitCode !== 0) return exitFailure('ps', result.exitCode, result.stderr);
      const startedAt = parseLstart(result.stdout);
      return startedAt === undefined ? unparseable('ps', result.stdout) : { kind: 'value', value: startedAt };
    },
    holdersOf: async (marker) => {
      const result = await attempt(() => run(LSOF_BINARY, ['-w', '-t', '--', marker], { env, timeoutMs: listTimeoutMs }));
      if (isFailure(result)) return result;
      if (result.exitCode === NO_MATCH_EXIT_CODE) {
        if (result.stdout.trim() === '' && result.stderr.trim() === '') return { kind: 'value', value: [] };
        if (markerMissing(marker, result.stderr)) return { kind: 'gone' };
        return exitFailure('lsof', result.exitCode, result.stderr);
      }
      if (result.exitCode !== 0) return exitFailure('lsof', result.exitCode, result.stderr);
      const holders = parsePidList(result.stdout);
      return holders === undefined || holders.length === 0 ? unparseable('lsof', result.stdout) : { kind: 'value', value: holders };
    },
    groupsOf: async (pids) => {
      if (pids.length === 0) return { kind: 'value', value: new Map() };
      const result = await attempt(() => run(PS_BINARY, ['-o', 'pid=,pgid=', '-p', pids.join(',')], { env, timeoutMs: listTimeoutMs }));
      if (isFailure(result)) return result;
      if (result.exitCode === NO_MATCH_EXIT_CODE && result.stdout.trim() === '' && result.stderr.trim() === '') return { kind: 'value', value: new Map() };
      if (result.exitCode !== 0) return exitFailure('ps', result.exitCode, result.stderr);
      const rows = parsePidGroupRows(result.stdout);
      return rows === undefined ? unparseable('ps', result.stdout) : { kind: 'value', value: rows };
    },
  };
};
