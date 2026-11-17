import { forgetProjectCheck, readProjectCheck, recordProjectCheck, settingsWriterPorts } from '@momonga/config';
import { hostPaths, resolveLayoutLocks } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { escapeTerminalLine } from '@momonga/protocol';
import type { CliPorts } from '../ports.ts';
import { UsageError } from '../usage-error.ts';

type CheckPorts = Pick<CliPorts, 'cwd' | 'env' | 'interrupt' | 'stdout'>;

const writerOf = (ports: CheckPorts, paths: MomongaPaths) => settingsWriterPorts(paths.home, { lock: resolveLayoutLocks(paths).mechanism, signal: ports.interrupt });

const folderLine = async (ports: CheckPorts, shown: string): Promise<void> => {
  const folder = await hostPaths(ports.interrupt).canonicalPath(ports.cwd);
  ports.stdout.write(`${escapeTerminalLine(folder)}: ${escapeTerminalLine(shown)}\n`);
};

export const projectCheckShow = async (ports: CheckPorts, paths: MomongaPaths): Promise<number> => {
  const check = await readProjectCheck({ env: ports.env, home: paths.home, projectDir: ports.cwd, signal: ports.interrupt });
  await folderLine(ports, check === undefined ? 'no check' : 'declined' in check ? 'declined' : check.commands.join(' && '));
  return 0;
};

export const projectCheckSet = async (ports: CheckPorts, paths: MomongaPaths, command: string): Promise<number> => {
  if (command.trim() === '') throw new UsageError('a check needs the command that checks the work, for example "npm test"');
  await recordProjectCheck(paths.home, ports.cwd, { commands: [command] }, writerOf(ports, paths));
  await folderLine(ports, command);
  return 0;
};

export const projectCheckClear = async (ports: CheckPorts, paths: MomongaPaths): Promise<number> => {
  await forgetProjectCheck(paths.home, ports.cwd, writerOf(ports, paths));
  await folderLine(ports, 'no check');
  return 0;
};
