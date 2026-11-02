import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseChecksumListing } from '@momonga/foundation';
import { UpdateError } from './errors.ts';
import type { StagedFile, UpdateFs, UpdatePorts } from './ports.ts';
import { readText, requestOrFail } from './release.ts';
import type { Release } from './release.ts';
import { CHECKSUMS_ASSET, assetNameFor, resolveUpdateSource } from './source.ts';
import type { BuildUpdateInputs, UpdateEndpoints, UpdateSource } from './source.ts';

export const CANDIDATE_CHECK_TIMEOUT_MS = 30_000;

export type UpdateTarget = { source: UpdateSource; asset: string };

export const resolveUpdateTarget = (ports: Pick<UpdatePorts, 'self' | 'platform' | 'arch'>, inputs: BuildUpdateInputs, endpoints: UpdateEndpoints): UpdateTarget => {
  if (ports.self.kind !== 'single-binary') {
    throw new UpdateError('not_single_executable', 'self-update only replaces a momonga single executable; this process is running from source under node', {
      detail: ports.self.execPath,
      remediation: 'install a release build with the install script, or update the source checkout',
    });
  }
  const source = resolveUpdateSource(inputs, endpoints, ports.platform);
  return { source, asset: assetNameFor(ports.platform, ports.arch) };
};

const releaseUrl = (source: UpdateSource, release: Release, name: string): string =>
  `${source.endpoints.downloadBaseUrl}/${source.repo}/releases/download/${release.tag}/${name}`;

const expectedChecksum = async (ports: UpdatePorts, target: UpdateTarget, release: Release, signal: AbortSignal): Promise<string> => {
  const what = `downloading ${CHECKSUMS_ASSET}`;
  const response = await requestOrFail(ports, releaseUrl(target.source, release, CHECKSUMS_ASSET), signal, 'checksums_unavailable', what);
  const listing = parseChecksumListing(await readText(response, signal, 'checksums_unavailable', what), CHECKSUMS_ASSET);
  const checksum = listing.get(target.asset);
  if (checksum === undefined) {
    throw new UpdateError('checksum_entry_missing', `${CHECKSUMS_ASSET} of ${release.tag} has no entry for ${target.asset}`, { detail: releaseUrl(target.source, release, CHECKSUMS_ASSET) });
  }
  return checksum;
};

const downloadInto = async (ports: UpdatePorts, url: string, staged: StagedFile, signal: AbortSignal): Promise<string> => {
  const what = 'downloading the release executable';
  const response = await requestOrFail(ports, url, signal, 'download_failed', what);
  const hash = createHash('sha256');
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      await staged.write(chunk);
    }
  } catch (error) {
    if (signal.aborted) throw error;
    throw new UpdateError('download_failed', `${what} was interrupted: ${error instanceof Error ? error.message : String(error)}`, { detail: url, cause: error });
  }
  return hash.digest('hex');
};

const developerIdRequirement = (teamId: string): string =>
  `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`;

export const CODESIGN = '/usr/bin/codesign';

const verifySignature = async (ports: UpdatePorts, source: UpdateSource, file: string): Promise<void> => {
  if (source.signature.kind === 'none') return;
  const { teamId } = source.signature;
  const result = await ports.run(CODESIGN, ['--verify', '--strict', '--verbose=2', `-R=${developerIdRequirement(teamId)}`, file], {
    env: ports.env,
    timeoutMs: CANDIDATE_CHECK_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new UpdateError('signature_rejected', `the downloaded executable is not a valid Developer ID signature of Apple Team ID ${teamId}`, {
      detail: result.stderr.trim(),
    });
  }
};

const verifyCandidateRuns = async (ports: UpdatePorts, file: string, release: Release): Promise<void> => {
  const result = await ports.run(file, ['--version'], { env: ports.env, timeoutMs: CANDIDATE_CHECK_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new UpdateError('candidate_unusable', `the downloaded executable exited with code ${result.exitCode} for --version`, { detail: result.stderr.trim() });
  }
  if (result.stdout.trim() !== release.version.text) {
    throw new UpdateError('candidate_unusable', `the downloaded executable reports version ${JSON.stringify(result.stdout.trim())}, not ${release.version.text} of ${release.tag}`);
  }
};

const abandon = async (fs: UpdateFs, staged: StagedFile, original: unknown): Promise<never> => {
  try {
    await staged.close();
    await fs.remove(staged.path);
  } catch (cleanup) {
    throw new AggregateError([original, cleanup], 'the update failed and its staging file could not be removed');
  }
  throw original;
};

export type InstallOptions = { restartDaemon: boolean; signal: AbortSignal };

export type InstallResult = { from: string; to: string; target: string; daemonRestarted: boolean };

const restartDaemon = async (ports: UpdatePorts, target: string): Promise<void> => {
  const result = await ports.run(target, ['daemon', 'start'], { env: ports.env });
  if (result.exitCode !== 0) {
    throw new UpdateError('daemon_restart_failed', `the update was installed but the new daemon did not start (exit code ${result.exitCode})`, {
      detail: `${result.stdout}${result.stderr}`.trim(),
      remediation: 'run `momonga daemon start`',
    });
  }
};

const installLocked = async (ports: UpdatePorts, update: UpdateTarget, release: Release, options: InstallOptions): Promise<InstallResult> => {
  const { signal } = options;
  const target = await ports.fs.realpath(ports.self.execPath);
  const directory = path.dirname(target);
  const daemonWasRunning = options.restartDaemon && (await ports.daemon.running());
  await ports.fs.removeLeftovers(directory);
  const expected = await expectedChecksum(ports, update, release, signal);
  const staged = await ports.fs.stage(directory, await ports.fs.modeOf(target));
  try {
    const actual = await downloadInto(ports, releaseUrl(update.source, release, update.asset), staged, signal);
    await staged.close();
    if (actual !== expected) {
      throw new UpdateError('checksum_mismatch', `sha256 of ${update.asset} does not match ${CHECKSUMS_ASSET}: expected ${expected}, got ${actual}`, {
        remediation: 'nothing was installed; try again later',
      });
    }
    await verifySignature(ports, update.source, staged.path);
    await verifyCandidateRuns(ports, staged.path, release);
    await ports.fs.publish(staged.path, target);
  } catch (error) {
    return abandon(ports.fs, staged, error);
  }
  if (daemonWasRunning) await restartDaemon(ports, target);
  return { from: ports.version, to: release.version.text, target, daemonRestarted: daemonWasRunning };
};

export const installRelease = async (ports: UpdatePorts, update: UpdateTarget, release: Release, options: InstallOptions): Promise<InstallResult> => {
  const lock = await ports.lock.acquire();
  if (lock === undefined) {
    throw new UpdateError('update_in_progress', 'another momonga update is already running', { remediation: 'wait for it to finish, then run `momonga update` again' });
  }
  try {
    return await installLocked(ports, update, release, options);
  } finally {
    lock.release();
  }
};
