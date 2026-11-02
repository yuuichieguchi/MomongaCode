import type { CommandRunner } from './command-runner.ts';
import type { ProcessInspector } from './inspector-types.ts';

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

export const parsePidList = (text: string): number[] =>
  text
    .split('\n')
    .filter((line) => /^\d+$/.test(line.trim()))
    .map((line) => Number(line.trim()));

export const parsePidGroupRows = (text: string): Map<number, number> =>
  new Map(
    text.split('\n').flatMap((line): Array<[number, number]> => {
      const match = ROW_FORMAT.exec(line);
      return match === null ? [] : [[Number(match[1]), Number(match[2])]];
    }),
  );

export type DarwinInspectorPorts = { run: CommandRunner; startTimeoutMs: number };

export const createDarwinInspector = ({ run, startTimeoutMs }: DarwinInspectorPorts): ProcessInspector => {
  const env = { LC_ALL: 'C' };
  return {
    startTimeOf: async (pid) => {
      let result;
      try {
        result = await run(PS_BINARY, ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C', TZ: 'UTC' }, timeoutMs: startTimeoutMs });
      } catch {
        return undefined;
      }
      return result.exitCode === 0 ? parseLstart(result.stdout) : undefined;
    },
    holdersOf: async (marker) => {
      const result = await run(LSOF_BINARY, ['-t', '--', marker], { env });
      if (result.exitCode === NO_MATCH_EXIT_CODE) return [];
      if (result.exitCode !== 0) throw new Error(`lsof exited with ${result.exitCode}: ${result.stderr.trim()}`);
      return parsePidList(result.stdout);
    },
    groupsOf: async (pids) => {
      const result = await run(PS_BINARY, ['-o', 'pid=,pgid=', '-p', pids.join(',')], { env });
      if (result.exitCode === NO_MATCH_EXIT_CODE) return new Map();
      if (result.exitCode !== 0) throw new Error(`ps exited with ${result.exitCode}: ${result.stderr.trim()}`);
      return parsePidGroupRows(result.stdout);
    },
  };
};
