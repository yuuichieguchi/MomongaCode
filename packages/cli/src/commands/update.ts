import { UpdateError } from '../update/errors.ts';
import type { UpdateWiring } from '../update/background.ts';
import { installRelease, resolveUpdateTarget } from '../update/install.ts';
import type { DaemonRestart } from '../update/install.ts';
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

export type InstalledDaemon = Exclude<DaemonRestart, { kind: 'failed' }>;

const daemonAfterUpdateText = (to: string, daemon: InstalledDaemon): string => {
  if (daemon.kind === 'not_running') return `Updated to v${to}. No daemon was running; the next command starts v${to}.`;
  const { steps, jobs, versions, notKnown } = daemon.retiring;
  if (steps + jobs === 0 && notKnown.length === 0) return `Updated to v${to}. The daemon is running the new version.`;
  const notKnownText = notKnown.length === 0 ? '' : `, and the work of ${notKnown.join(', ')} is not known: its runtime did not answer in time`;
  return `Updated to v${to}. The daemon is running the new version now. ${steps} running steps and ${jobs} background jobs of ${versions.map((version) => `v${version}`).join(', ')} finish in the background${notKnownText}; nothing is interrupted.`;
};

export const installedText = (result: { from: string; to: string; target: string; daemon: InstalledDaemon }): string =>
  `${escapedLines([`updated momonga ${result.from} -> ${result.to} (${result.target})`, daemonAfterUpdateText(result.to, result.daemon)])}\n`;

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
  stdout.write(installedText({ from: result.from, to: result.to, target: result.target, daemon: result.restart }));
  return 0;
};
