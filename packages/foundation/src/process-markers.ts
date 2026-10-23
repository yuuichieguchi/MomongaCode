import { execFile } from 'node:child_process';
import { isProcessAlive } from './process-alive.ts';
import type { SignalSender } from './process-alive.ts';

const ROW_FORMAT = /^\s*(\d+)\s+(\d+)\s*$/;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runTool = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { env: { LC_ALL: 'C' } }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else if (String(error.code) === '1') resolve('');
      else reject(error);
    });
  });

export const findHolders = async (marker: string): Promise<number[]> => {
  const output = await runTool('/usr/sbin/lsof', ['-t', '--', marker]);
  return output
    .split('\n')
    .filter((line) => /^\d+$/.test(line.trim()))
    .map((line) => Number(line.trim()))
    .filter((pid) => pid !== process.pid);
};

export const holderGroups = async (holders: readonly number[]): Promise<number[]> => {
  const output = await runTool('/bin/ps', ['-o', 'pid=,pgid=', '-p', holders.join(',')]);
  return output.split('\n').flatMap((line) => {
    const match = ROW_FORMAT.exec(line);
    return match === null ? [] : [Number(match[2])];
  });
};

const signalTargets = (send: SignalSender, targets: readonly number[], signal: NodeJS.Signals): number[] => {
  const unsignalled: number[] = [];
  for (const target of targets) {
    try {
      send(target, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') unsignalled.push(Math.abs(target));
      else if (code !== 'ESRCH') throw error;
    }
  }
  return unsignalled;
};

export type MarkerReconcileResult = { outcome: 'unknown'; output: string; leftAloneGroup?: number; leftAlonePids: number[]; unsignalledPids: number[] };

type StructuredFindings = { leftAloneGroup?: number; leftAlonePids?: number[]; unsignalledPids?: number[] };

const unknownResult = (detail: string, { leftAloneGroup, leftAlonePids = [], unsignalledPids = [] }: StructuredFindings = {}): MarkerReconcileResult => ({
  outcome: 'unknown',
  output: `${detail} The effect of the interrupted command is unknown; inspect the current state before retrying it.`,
  ...(leftAloneGroup === undefined ? {} : { leftAloneGroup }),
  leftAlonePids,
  unsignalledPids,
});

export const reconcileProcessGroup = async (
  recorded: { pgid: number; marker: string },
  { killGraceMs = 2000, kill = (pid, signal) => void process.kill(pid, signal) }: { killGraceMs?: number; kill?: SignalSender } = {},
): Promise<MarkerReconcileResult> => {
  const { pgid, marker } = recorded;
  const holders = await findHolders(marker);
  const groupAlive = isProcessAlive(-pgid, kill);
  if (!groupAlive && holders.length === 0) return unknownResult('The interrupted command is no longer running.');
  if (holders.length === 0) {
    return unknownResult(
      `Processes in group ${pgid} are still running but could not be verified as belonging to this call (for example they closed the inherited descriptor), so they were left alone.`,
      { leftAloneGroup: pgid },
    );
  }
  const groupVerified = groupAlive && (await holderGroups(holders)).includes(pgid);
  const termTargets = [...(groupVerified ? [-pgid] : []), ...holders];
  const unsignalled = new Set(signalTargets(kill, termTargets, 'SIGTERM'));
  await sleep(killGraceMs);

  const remaining = await findHolders(marker);
  const stillInGroup = groupVerified && isProcessAlive(-pgid, kill) && remaining.length > 0 && (await holderGroups(remaining)).includes(pgid);
  const killTargets = [...(stillInGroup ? [-pgid] : []), ...remaining];
  for (const pid of signalTargets(kill, killTargets, 'SIGKILL')) unsignalled.add(pid);

  const notes: string[] = [];
  if (unsignalled.size > 0) notes.push(`Could not signal process ${[...unsignalled].join(', ')}.`);
  const leftAloneGroup = groupVerified && !stillInGroup && isProcessAlive(-pgid, kill) ? pgid : undefined;
  const leftAlonePids = holders.filter((pid) => !remaining.includes(pid) && isProcessAlive(pid, kill));
  const leftAlone = [...(leftAloneGroup === undefined ? [] : [`group ${pgid}`]), ...leftAlonePids.map((pid) => `process ${pid}`)];
  if (leftAlone.length > 0) notes.push(`Still running but no longer verified as belonging to this call, so left alone: ${leftAlone.join(', ')}.`);
  return unknownResult(['The interrupted command was stopped.', ...notes].join(' '), {
    ...(leftAloneGroup === undefined ? {} : { leftAloneGroup }),
    leftAlonePids,
    unsignalledPids: [...unsignalled],
  });
};
