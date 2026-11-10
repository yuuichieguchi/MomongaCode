import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceProbe } from '@momonga/eval';
import { groupSignalsOf, hostProcessGroupPort, launchGroupLeader, signalGroup } from '@momonga/foundation';

const absentOnMissing = (error: NodeJS.ErrnoException): undefined => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
};

const filesUnder = async (root: string, relative: string): Promise<string[]> => {
  const absolute = path.join(root, relative);
  const stat = await fs.lstat(absolute).catch(absentOnMissing);
  if (stat === undefined) return [];
  if (!stat.isDirectory()) return [relative];
  const names = await fs.readdir(absolute);
  const nested = await Promise.all(names.sort().map((name) => filesUnder(root, relative === '' ? name : `${relative}/${name}`)));
  return nested.flat();
};

const contentOf = (file: string): Promise<Buffer | undefined> => fs.readFile(file).catch(absentOnMissing);

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const strongestSignal = (): NodeJS.Signals => {
  const signals = groupSignalsOf(hostProcessGroupPort());
  return signals[signals.length - 1] ?? signals[0];
};

const runShell = (env: Readonly<Record<string, string>>, command: string, timeoutMs: number, cwd: string): Promise<{ exitCode: number | null; timedOut: boolean }> =>
  new Promise((resolve, reject) => {
    const { child, pgid } = launchGroupLeader({ file: '/bin/sh', args: ['-c', command], cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pgid !== undefined) signalGroup(pgid, strongestSignal()).catch(reject);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut });
    });
  });

export const nodeWorkspaceProbe = (env: Readonly<Record<string, string>>): WorkspaceProbe => ({
  run: (command, timeoutMs, cwd) => runShell(env, command, timeoutMs, cwd),
  digest: async (cwd, paths) => {
    const entries: string[] = [];
    for (const relative of [...paths].sort()) {
      const content = await contentOf(path.join(cwd, relative));
      entries.push(`${relative}\0${content === undefined ? 'absent' : sha256(content)}`);
    }
    return sha256(entries.join('\n'));
  },
  changedPaths: async (cwd, baseDir) => {
    const all = [...new Set([...(await filesUnder(cwd, '')), ...(await filesUnder(baseDir, ''))])].sort();
    const changed: string[] = [];
    for (const relative of all) {
      const [now, before] = await Promise.all([contentOf(path.join(cwd, relative)), contentOf(path.join(baseDir, relative))]);
      if (now === undefined || before === undefined ? now !== before : !now.equals(before)) changed.push(relative);
    }
    return changed;
  },
});
