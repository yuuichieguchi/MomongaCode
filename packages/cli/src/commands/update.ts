import { UpdateError } from '../update/errors.ts';
import type { UpdateWiring } from '../update/background.ts';
import { installRelease, resolveUpdateTarget } from '../update/install.ts';
import { checkForUpdate } from '../update/release.ts';
import type { Sink } from '../ports.ts';

export type UpdateCommandOptions = { checkOnly: boolean; interrupt: AbortSignal };

export const runUpdate = async (wiring: UpdateWiring, stdout: Sink, options: UpdateCommandOptions): Promise<number> => {
  const { ports } = wiring;
  const target = resolveUpdateTarget(ports, wiring.build, wiring.endpoints);
  const check = await checkForUpdate(ports, target.source, options.interrupt);
  if (check.kind === 'up_to_date') {
    stdout.write(`momonga ${check.current.text} is up to date\n`);
    return 0;
  }
  if (options.checkOnly) {
    stdout.write(
      check.kind === 'ahead'
        ? `momonga ${check.current.text} is newer than the latest release ${check.latest.tag}\n`
        : `momonga ${check.latest.version.text} is available (running ${check.current.text}); run \`momonga update\` to install it\n`,
    );
    return 0;
  }
  if (check.kind === 'ahead') {
    throw new UpdateError('downgrade_refused', `the latest release ${check.latest.tag} is older than the running version ${check.current.text}; refusing to downgrade`, {
      remediation: 'install an older version explicitly with the install script (MOMONGA_VERSION)',
    });
  }
  const result = await installRelease(ports, target, check.latest, { restartDaemon: true, signal: options.interrupt });
  stdout.write(`updated momonga ${result.from} -> ${result.to} (${result.target})\n`);
  if (result.daemonRestarted) stdout.write('restarted the daemon on the new version\n');
  return 0;
};
