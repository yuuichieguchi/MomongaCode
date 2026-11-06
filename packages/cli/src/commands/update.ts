import { UpdateError } from '../update/errors.ts';
import type { UpdateWiring } from '../update/background.ts';
import { installRelease, resolveUpdateTarget } from '../update/install.ts';
import { checkForUpdate } from '../update/release.ts';
import type { Sink } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';
import type { UpdateCheck } from '../update/release.ts';

export type UpdateCommandOptions = { checkOnly: boolean; interrupt: AbortSignal };

export const checkOnlyText = (check: Exclude<UpdateCheck, { kind: 'up_to_date' }>): string =>
  `${escapedLines([
    check.kind === 'ahead'
      ? `momonga ${check.current.text} is newer than the latest release ${check.latest.tag}`
      : `momonga ${check.latest.version.text} is available (running ${check.current.text}); run \`momonga update\` to install it`,
  ])}\n`;

export const installedText = (result: { from: string; to: string; target: string; daemonRestarted: boolean }): string =>
  `${escapedLines([`updated momonga ${result.from} -> ${result.to} (${result.target})`, ...(result.daemonRestarted ? ['restarted the daemon on the new version'] : [])])}\n`;

export const upToDateText = (currentText: string): string => `${escapedLines([`momonga ${currentText} is up to date`])}\n`;

export const runUpdate = async (wiring: UpdateWiring, stdout: Sink, options: UpdateCommandOptions): Promise<number> => {
  const { ports } = wiring;
  const target = resolveUpdateTarget(ports, wiring.build, wiring.endpoints);
  const check = await checkForUpdate(ports, target.source, options.interrupt);
  if (check.kind === 'up_to_date') {
    stdout.write(upToDateText(check.current.text));
    return 0;
  }
  if (options.checkOnly) {
    stdout.write(checkOnlyText(check));
    return 0;
  }
  if (check.kind === 'ahead') {
    throw new UpdateError('downgrade_refused', `the latest release ${check.latest.tag} is older than the running version ${check.current.text}; refusing to downgrade`, {
      remediation: 'install an older version explicitly with the install script (MOMONGA_VERSION)',
    });
  }
  const result = await installRelease(ports, target, check.latest, { signal: options.interrupt });
  if (result.restart.kind === 'failed') throw result.restart.error;
  stdout.write(installedText({ from: result.from, to: result.to, target: result.target, daemonRestarted: result.restart.kind === 'restarted' }));
  return 0;
};
