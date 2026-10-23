import { execFile } from 'node:child_process';
import type { ReconcileResult } from './types.ts';

const ROW_FORMAT = /^\s*(\d+)\s+(\d+)\s*$/;

export type SignalSender = (pid: number, signal: NodeJS.Signals | 0) => void;

const probeAlive = (send: SignalSender, target: number): boolean => {
  try {
    send(target, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
};

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

const holderGroups = async (holders: readonly number[]): Promise<number[]> => {
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

const unknownResult = (detail: string): ReconcileResult => ({
  outcome: 'unknown',
  output: `${detail} The effect of the interrupted command is unknown; inspect the current state before retrying it.`,
});

export const reconcileProcessGroup = async (
  recorded: { pgid: number; marker: string },
  { killGraceMs = 2000, kill = (pid, signal) => void process.kill(pid, signal) }: { killGraceMs?: number; kill?: SignalSender } = {},
): Promise<ReconcileResult> => {
  const { pgid, marker } = recorded;
  const holders = await findHolders(marker);
  const groupAlive = probeAlive(kill, -pgid);
  if (!groupAlive && holders.length === 0) return unknownResult('The interrupted command is no longer running.');
  if (holders.length === 0) {
    return unknownResult(
      `Processes in group ${pgid} are still running but could not be verified as belonging to this call (for example they closed the inherited descriptor), so they were left alone.`,
    );
  }
  const groupVerified = groupAlive && (await holderGroups(holders)).includes(pgid);
  const termTargets = [...(groupVerified ? [-pgid] : []), ...holders];
  const unsignalled = new Set(signalTargets(kill, termTargets, 'SIGTERM'));
  await sleep(killGraceMs);

  const remaining = await findHolders(marker);
  const stillInGroup = groupVerified && probeAlive(kill, -pgid) && remaining.length > 0 && (await holderGroups(remaining)).includes(pgid);
  const killTargets = [...(stillInGroup ? [-pgid] : []), ...remaining];
  for (const pid of signalTargets(kill, killTargets, 'SIGKILL')) unsignalled.add(pid);

  const notes: string[] = [];
  if (unsignalled.size > 0) notes.push(`Could not signal process ${[...unsignalled].join(', ')}.`);
  const leftAlone = [
    ...(groupVerified && !stillInGroup && probeAlive(kill, -pgid) ? [`group ${pgid}`] : []),
    ...holders.filter((pid) => !remaining.includes(pid) && probeAlive(kill, pid)).map((pid) => `process ${pid}`),
  ];
  if (leftAlone.length > 0) notes.push(`Still running but no longer verified as belonging to this call, so left alone: ${leftAlone.join(', ')}.`);
  return unknownResult(['The interrupted command was stopped.', ...notes].join(' '));
};
