import { createHash } from 'node:crypto';
import path from 'node:path';
import { RELEASE_SIGNATURE_ASSET, RELEASE_SIGNATURE_TOOL, parseChecksumListing, verifyReleaseSignature } from '@momonga/foundation';
import type { PlaceFile, ReleaseSignatureVerdict } from '@momonga/foundation';
import { escapedLines } from '../terminal-writer.ts';
import { UpdateError } from './errors.ts';
import type { StagedFile, UpdatePorts } from './ports.ts';
import { readText, requestOrFail } from './release.ts';
import type { Release } from './release.ts';
import { CHECKSUMS_ASSET, assetNameFor, resolveUpdateSource } from './source.ts';
import type { BuildUpdateInputs, UpdateEndpoints, UpdateSource } from './source.ts';

export const CANDIDATE_CHECK_TIMEOUT_MS = 30_000;

export const DAEMON_RESTART_REMEDIATION = 'run `momonga daemon start`';

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

const SIGNING_FILE_MODE = 0o600;

export const reportUnremoved = (ports: Pick<UpdatePorts, 'stderr'>, file: string, cleanup: unknown): void => {
  ports.stderr.write(`${escapedLines([`momonga: the staging file ${file} could not be removed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`])}\n`);
};

const placeSigningFile =
  (ports: UpdatePorts, directory: string): PlaceFile =>
  async (content) => {
    const staged = await inDirectory(directory, () => ports.fs.stage(directory, SIGNING_FILE_MODE));
    try {
      await staged.write(new TextEncoder().encode(content));
      await staged.close();
    } catch (error) {
      await abandon(ports, staged, error);
    }
    return {
      path: staged.path,
      remove: async () => {
        try {
          await ports.fs.remove(staged.path);
        } catch (cleanup) {
          reportUnremoved(ports, staged.path, cleanup);
        }
      },
    };
  };

const isMissingProgram = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const verifyChecksumsSignature = async (ports: UpdatePorts, source: UpdateSource, directory: string, checksums: string, release: Release, signal: AbortSignal): Promise<void> => {
  const what = `downloading ${RELEASE_SIGNATURE_ASSET}`;
  const response = await requestOrFail(ports, releaseUrl(source, release, RELEASE_SIGNATURE_ASSET), signal, 'signature_unavailable', what);
  const signature = await readText(response, signal, 'signature_unavailable', what);
  let verdict: ReleaseSignatureVerdict;
  try {
    verdict = await verifyReleaseSignature({
      run: ports.run,
      env: ports.env,
      place: placeSigningFile(ports, directory),
      publicKey: source.publicKey,
      checksums,
      signature,
      timeoutMs: CANDIDATE_CHECK_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    if (!isMissingProgram(error)) throw error;
    throw new UpdateError('signature_tool_missing', `${RELEASE_SIGNATURE_TOOL} is required to verify the release signature and was not found`, {
      remediation: 'install the OpenSSH client, then run `momonga update` again',
      cause: error,
    });
  }
  if (verdict.kind === 'tool_unusable') {
    throw new UpdateError('signature_tool_unusable', `${RELEASE_SIGNATURE_TOOL} could not verify the release signature; it may be too old to support \`-Y verify\``, {
      detail: verdict.detail,
      remediation: 'upgrade the OpenSSH client (signature verification needs OpenSSH 8.0 or later), then run `momonga update` again; nothing was installed',
    });
  }
  if (verdict.kind === 'invalid') {
    throw new UpdateError('signature_rejected', `${CHECKSUMS_ASSET} of ${release.tag} is not signed by the release key this build pins`, {
      detail: verdict.detail,
      remediation: 'nothing was installed',
    });
  }
};

const expectedChecksum = async (ports: UpdatePorts, target: UpdateTarget, release: Release, directory: string, signal: AbortSignal): Promise<string> => {
  const what = `downloading ${CHECKSUMS_ASSET}`;
  const response = await requestOrFail(ports, releaseUrl(target.source, release, CHECKSUMS_ASSET), signal, 'checksums_unavailable', what);
  const checksums = await readText(response, signal, 'checksums_unavailable', what);
  await verifyChecksumsSignature(ports, target.source, directory, checksums, release, signal);
  const listing = parseChecksumListing(checksums, CHECKSUMS_ASSET);
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

const verifyCodesign = async (ports: UpdatePorts, source: UpdateSource, file: string, signal: AbortSignal): Promise<void> => {
  if (source.codesign.kind === 'none') return;
  const { teamId } = source.codesign;
  const result = await ports.run(CODESIGN, ['--verify', '--strict', '--verbose=2', `-R=${developerIdRequirement(teamId)}`, file], {
    env: ports.env,
    timeoutMs: CANDIDATE_CHECK_TIMEOUT_MS,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new UpdateError('signature_rejected', `the downloaded executable is not a valid Developer ID signature of Apple Team ID ${teamId}`, {
      detail: result.stderr.trim(),
    });
  }
};

const verifyCandidateRuns = async (ports: UpdatePorts, file: string, release: Release, signal: AbortSignal): Promise<void> => {
  const result = await ports.run(file, ['--version'], { env: ports.env, timeoutMs: CANDIDATE_CHECK_TIMEOUT_MS, signal });
  if (result.exitCode !== 0) {
    throw new UpdateError('candidate_unusable', `the downloaded executable exited with code ${result.exitCode} for --version`, { detail: result.stderr.trim() });
  }
  if (result.stdout.trim() !== release.version.text) {
    throw new UpdateError('candidate_unusable', `the downloaded executable reports version ${JSON.stringify(result.stdout.trim())}, not ${release.version.text} of ${release.tag}`);
  }
};

const PERMISSION_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EROFS']);

const inDirectory = async <T>(directory: string, step: () => Promise<T>): Promise<T> => {
  try {
    return await step();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (typeof code !== 'string' || !PERMISSION_CODES.has(code)) throw error;
    throw new UpdateError('install_directory_not_writable', `momonga cannot write to ${directory}, where the running executable is installed`, {
      detail: `${code}: ${error instanceof Error ? error.message : String(error)}`,
      remediation: 'run the update as the user that owns that directory, or reinstall with the install script',
      cause: error,
    });
  }
};

const abandon = async (ports: UpdatePorts, staged: StagedFile, original: unknown): Promise<never> => {
  try {
    await staged.close();
    await ports.fs.remove(staged.path);
  } catch (cleanup) {
    reportUnremoved(ports, staged.path, cleanup);
  }
  throw original;
};

export type InstallOptions = { signal: AbortSignal };

export type DaemonRestart = { kind: 'not_running' } | { kind: 'restarted' } | { kind: 'failed'; error: unknown };

export type InstallResult = { from: string; to: string; target: string; restart: DaemonRestart };

const restartDaemon = async (ports: UpdatePorts, target: string, signal: AbortSignal): Promise<void> => {
  const result = await ports.run(target, ['daemon', 'start'], { env: ports.env, timeoutMs: await ports.daemon.restartBoundMs(), signal });
  if (result.exitCode !== 0) {
    throw new UpdateError('daemon_restart_failed', `the update was installed but the new daemon did not start (exit code ${result.exitCode})`, {
      detail: `${result.stdout}${result.stderr}`.trim(),
      remediation: DAEMON_RESTART_REMEDIATION,
    });
  }
};

export const installLocked = async (ports: UpdatePorts, update: UpdateTarget, release: Release, options: InstallOptions): Promise<InstallResult> => {
  const { signal } = options;
  const target = await ports.fs.realpath(ports.self.execPath);
  const directory = path.dirname(target);
  const daemonWasRunning = await ports.daemon.running();
  await inDirectory(directory, () => ports.fs.removeLeftovers(directory));
  const expected = await expectedChecksum(ports, update, release, directory, signal);
  const staged = await inDirectory(directory, async () => ports.fs.stage(directory, await ports.fs.modeOf(target)));
  try {
    const actual = await downloadInto(ports, releaseUrl(update.source, release, update.asset), staged, signal);
    await staged.close();
    if (actual !== expected) {
      throw new UpdateError('checksum_mismatch', `sha256 of ${update.asset} does not match ${CHECKSUMS_ASSET}: expected ${expected}, got ${actual}`, {
        remediation: 'nothing was installed; try again later',
      });
    }
    await verifyCodesign(ports, update.source, staged.path, signal);
    await verifyCandidateRuns(ports, staged.path, release, signal);
    await inDirectory(directory, () => ports.fs.publish(staged.path, target));
  } catch (error) {
    return abandon(ports, staged, error);
  }
  return { from: ports.version, to: release.version.text, target, restart: daemonWasRunning ? await restartRunningDaemon(ports, target, signal) : { kind: 'not_running' } };
};

const restartRunningDaemon = async (ports: UpdatePorts, target: string, signal: AbortSignal): Promise<DaemonRestart> => {
  try {
    await restartDaemon(ports, target, signal);
    return { kind: 'restarted' };
  } catch (error) {
    return { kind: 'failed', error };
  }
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
