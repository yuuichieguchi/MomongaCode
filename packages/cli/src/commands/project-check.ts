import { readProjectCheck, writeProjectCheck } from '@momonga/config';
import { hostPaths, resolveLayoutLocks } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { escapeTerminalLine } from '@momonga/protocol';
import type { CliPorts } from '../ports.ts';
import { UsageError } from '../usage-error.ts';

type CheckPorts = Pick<CliPorts, 'cwd' | 'interrupt' | 'stdout'>;

const currentFolder = async (ports: CheckPorts): Promise<string> => {
  const result = await hostPaths(ports.interrupt).canonicalDirectory(ports.cwd);
  if (!result.ok) throw new Error(`the current folder ${ports.cwd} ${result.reason}`);
  return result.path;
};

const writerOf = (ports: CheckPorts, paths: MomongaPaths) => ({ lock: resolveLayoutLocks(paths).mechanism, signal: ports.interrupt });

export const projectCheckShow = async (ports: CheckPorts, paths: MomongaPaths): Promise<number> => {
  const folder = await currentFolder(ports);
  const check = await readProjectCheck(paths.home, folder, ports.interrupt);
  const shown = check === undefined ? 'no check' : 'declined' in check ? 'declined' : check.commands.join(' && ');
  ports.stdout.write(`${escapeTerminalLine(folder)}: ${escapeTerminalLine(shown)}\n`);
  return 0;
};

export const projectCheckSet = async (ports: CheckPorts, paths: MomongaPaths, command: string): Promise<number> => {
  if (command.trim() === '') throw new UsageError('a check needs the command that checks the work, for example "npm test"');
  const folder = await currentFolder(ports);
  await writeProjectCheck(paths.home, paths.settingsFile, folder, { commands: [command] }, writerOf(ports, paths));
  ports.stdout.write(`${escapeTerminalLine(folder)}: ${escapeTerminalLine(command)}\n`);
  return 0;
};

export const projectCheckClear = async (ports: CheckPorts, paths: MomongaPaths): Promise<number> => {
  const folder = await currentFolder(ports);
  await writeProjectCheck(paths.home, paths.settingsFile, folder, undefined, writerOf(ports, paths));
  ports.stdout.write(`${escapeTerminalLine(folder)}: no check\n`);
  return 0;
};
