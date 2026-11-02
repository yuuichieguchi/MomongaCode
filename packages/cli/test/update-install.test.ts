import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runUpdate } from '../src/commands/update.ts';
import { UpdateError } from '../src/update/errors.ts';
import { assetNameFor } from '../src/update/source.ts';
import { checksumListing } from './fake-release-server.ts';
import { DAEMON_RESTART_BOUND_MS, NEW_BINARY, OLD_BINARY, TEAM_ID, setupUpdate } from './update-harness.ts';
import type { HarnessOptions, UpdateHarness } from './update-harness.ts';

const interrupt = (): AbortSignal => new AbortController().signal;

const update = (harness: UpdateHarness, checkOnly = false): Promise<number> =>
  runUpdate(harness.wiring, { write: (text) => void harness.stdout.push(text) }, { checkOnly, interrupt: interrupt() });

const assetOf = (harness: UpdateHarness): string => assetNameFor(harness.ports.platform, harness.ports.arch);

const publish = (harness: UpdateHarness, tag = 'v2.0.0', body = NEW_BINARY): void => {
  harness.server.publish(tag, { [assetOf(harness)]: body });
};

const expectUnchanged = (harness: UpdateHarness): void => {
  expect(harness.targetBytes().equals(OLD_BINARY)).toBe(true);
  expect(harness.directoryEntries()).toEqual(['momonga']);
};

const expectRejected = async (harness: UpdateHarness, code: UpdateError['code']): Promise<UpdateError> => {
  const error: unknown = await update(harness).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(UpdateError);
  expect((error as UpdateError).code).toBe(code);
  return error as UpdateError;
};

const darwin: HarnessOptions = { platform: 'darwin' };

describe('momonga update: a good update', () => {
  it('replaces the executable with the verified release, keeping its mode, and leaves no staging file', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);

    expect(await update(harness)).toBe(0);

    expect(harness.targetBytes().equals(NEW_BINARY)).toBe(true);
    expect(fs.statSync(harness.target).mode & 0o777).toBe(0o755);
    expect(harness.directoryEntries()).toEqual(['momonga']);
    expect(harness.stdout.join('')).toBe(`updated momonga 1.0.0 -> 2.0.0 (${harness.target})\n`);
    expect(harness.released.count).toBe(1);
  });

  it('smoke-runs the staged candidate before replacing and never runs codesign off macOS', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);

    await update(harness);

    const [version] = harness.runs;
    expect(harness.runs).toHaveLength(1);
    expect(version?.args).toEqual(['--version']);
    expect(path.dirname(version?.file ?? '')).toBe(harness.dir);
    expect(path.basename(version?.file ?? '')).toMatch(/^\.momonga-update\./);
    expect(version?.stagedContent).toBe(NEW_BINARY.toString());
    expect(version?.targetContent).toBe(OLD_BINARY.toString());
  });

  it('on macOS verifies the Developer ID team of the staged file with codesign before replacing', async (context) => {
    const harness = await setupUpdate(context, darwin);
    publish(harness);

    await update(harness);

    const codesign = harness.runs.find((call) => call.file === '/usr/bin/codesign');
    expect(codesign?.args.slice(0, 3)).toEqual(['--verify', '--strict', '--verbose=2']);
    expect(codesign?.args[3]).toContain(`certificate leaf[subject.OU] = "${TEAM_ID}"`);
    expect(codesign?.args[3]).toContain('anchor apple generic');
    expect(codesign?.args[4]).toBe(path.join(harness.dir, path.basename(codesign?.args[4] ?? '')));
    expect(codesign?.targetContent).toBe(OLD_BINARY.toString());
    expect(harness.targetBytes().equals(NEW_BINARY)).toBe(true);
  });

  it('replaces the real file when the running executable is reached through a symlink', async (context) => {
    const harness = await setupUpdate(context);
    const link = path.join(harness.dir, 'momonga-link');
    fs.symlinkSync(harness.target, link);
    harness.ports.self = { kind: 'single-binary', execPath: link };
    publish(harness);

    await update(harness);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(harness.targetBytes().equals(NEW_BINARY)).toBe(true);
  });

  it('keeps the symlink and replaces the real file when the daemon is restarted through it', async (context) => {
    const harness = await setupUpdate(context);
    const link = path.join(harness.dir, 'momonga-link');
    fs.symlinkSync(harness.target, link);
    harness.ports.self = { kind: 'single-binary', execPath: link };
    harness.control.daemonRunning = true;
    publish(harness);

    await update(harness);

    expect(fs.readlinkSync(link)).toBe(harness.target);
    expect(harness.runs.find((call) => call.args[0] === 'daemon')?.file).toBe(harness.target);
    expect(harness.directoryEntries()).toEqual(['momonga', 'momonga-link']);
  });

  it('removes staging files left behind by an earlier crashed update', async (context) => {
    const harness = await setupUpdate(context);
    fs.writeFileSync(path.join(harness.dir, '.momonga-update.deadbeef'), 'partial');
    fs.writeFileSync(path.join(harness.dir, 'unrelated'), 'keep');
    publish(harness);

    await update(harness);

    expect(harness.directoryEntries()).toEqual(['momonga', 'unrelated']);
  });
});

describe('momonga update: through a symlink, a failure before publishing', () => {
  const linked = async (context: Parameters<typeof setupUpdate>[0], options: HarnessOptions = {}) => {
    const harness = await setupUpdate(context, options);
    const link = path.join(harness.dir, 'momonga-link');
    fs.symlinkSync(harness.target, link);
    harness.ports.self = { kind: 'single-binary', execPath: link };
    return { harness, link };
  };

  const expectIntact = (harness: UpdateHarness, link: string): void => {
    expect(fs.readlinkSync(link)).toBe(harness.target);
    expect(harness.targetBytes().equals(OLD_BINARY)).toBe(true);
    expect(harness.directoryEntries()).toEqual(['momonga', 'momonga-link']);
  };

  it('leaves the link and the real file intact and removes the staging file after a checksum mismatch', async (context) => {
    const { harness, link } = await linked(context);
    harness.server.publish('v2.0.0', { [assetOf(harness)]: NEW_BINARY }, { checksums: checksumListing({ [assetOf(harness)]: OLD_BINARY }) });

    await expectRejected(harness, 'checksum_mismatch');

    expectIntact(harness, link);
  });

  it('leaves the link and the real file intact and removes the staging file after a rejected signature', async (context) => {
    const { harness, link } = await linked(context, darwin);
    harness.control.codesign = { exitCode: 3, stdout: '', stderr: 'rejected' };
    publish(harness);

    await expectRejected(harness, 'signature_rejected');

    expectIntact(harness, link);
  });

  it('leaves the link and the real file intact and removes the staging file after an unusable candidate', async (context) => {
    const { harness, link } = await linked(context);
    harness.control.reportedVersion = '9.9.9';
    publish(harness);

    await expectRejected(harness, 'candidate_unusable');

    expectIntact(harness, link);
  });

  it('reports an unwritable real directory behind the link as typed and leaves everything intact', async (context) => {
    const { harness, link } = await linked(context);
    publish(harness);
    fs.chmodSync(harness.dir, 0o555);
    try {
      await expectRejected(harness, 'install_directory_not_writable');
    } finally {
      fs.chmodSync(harness.dir, 0o755);
    }
    expectIntact(harness, link);
  });
});

describe('momonga update: a release that must not be installed', () => {
  it('rejects an asset that does not match SHA256SUMS and leaves the binary intact', async (context) => {
    const harness = await setupUpdate(context);
    harness.server.publish('v2.0.0', { [assetOf(harness)]: NEW_BINARY }, { checksums: checksumListing({ [assetOf(harness)]: Buffer.from('what the publisher signed') }) });

    const error = await expectRejected(harness, 'checksum_mismatch');

    expect(error.message).toContain('does not match SHA256SUMS');
    expectUnchanged(harness);
    expect(harness.runs).toEqual([]);
  });

  it('rejects a SHA256SUMS without an entry for this platform asset', async (context) => {
    const harness = await setupUpdate(context);
    harness.server.publish('v2.0.0', { [assetOf(harness)]: NEW_BINARY }, { checksums: checksumListing({ 'momonga-other-platform': NEW_BINARY }) });

    const error = await expectRejected(harness, 'checksum_entry_missing');

    expect(error.message).toContain(`has no entry for ${assetOf(harness)}`);
    expectUnchanged(harness);
    expect(harness.server.requests.filter((request) => request.includes(assetOf(harness)))).toEqual([]);
  });

  it('rejects a release that has no SHA256SUMS at all', async (context) => {
    const harness = await setupUpdate(context);
    harness.server.publish('v2.0.0', { [assetOf(harness)]: NEW_BINARY }, { checksums: undefined });

    await expectRejected(harness, 'checksums_unavailable');

    expectUnchanged(harness);
  });

  it('rejects a malformed SHA256SUMS listing', async (context) => {
    const harness = await setupUpdate(context);
    harness.server.publish('v2.0.0', { [assetOf(harness)]: NEW_BINARY }, { checksums: 'not a listing\n' });

    const error: unknown = await update(harness).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect((error as Error).message).toBe('malformed SHA256SUMS line: not a listing');
    expectUnchanged(harness);
  });

  it('rejects an executable whose signature is not the expected Developer ID team and shows codesign output', async (context) => {
    const harness = await setupUpdate(context, darwin);
    harness.control.codesign = { exitCode: 3, stdout: '', stderr: 'test requirement failed\n' };
    publish(harness);

    const error = await expectRejected(harness, 'signature_rejected');

    expect(error.message).toContain(`Apple Team ID ${TEAM_ID}`);
    expect(error.detail).toBe('test requirement failed');
    expectUnchanged(harness);
    expect(harness.runs.map((call) => call.file)).toEqual(['/usr/bin/codesign']);
  });

  it('rejects a candidate that exits non-zero for --version', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);
    harness.ports.run = async (file, args, options) => {
      harness.runs.push({ file, args, options, targetContent: '', stagedContent: undefined });
      return { exitCode: 9, stdout: '', stderr: 'cannot start' };
    };

    const error = await expectRejected(harness, 'candidate_unusable');

    expect(error.detail).toBe('cannot start');
    expectUnchanged(harness);
  });

  it('rejects a candidate that reports another version than its release tag', async (context) => {
    const harness = await setupUpdate(context);
    harness.control.reportedVersion = '1.9.9';
    publish(harness);

    const error = await expectRejected(harness, 'candidate_unusable');

    expect(error.message).toContain('reports version "1.9.9", not 2.0.0');
    expectUnchanged(harness);
  });

  it('refuses a downgrade without downloading anything', async (context) => {
    const harness = await setupUpdate(context, { version: '3.0.0' });
    publish(harness, 'v2.0.0');

    const error = await expectRejected(harness, 'downgrade_refused');

    expect(error.message).toContain('older than the running version 3.0.0');
    expect(harness.server.requests).toEqual([`GET /repos/acme/momonga/releases/latest`]);
    expectUnchanged(harness);
  });

  it('reports the running version as up to date when the latest release equals it', async (context) => {
    const harness = await setupUpdate(context, { version: '2.0.0' });
    publish(harness, 'v2.0.0');

    expect(await update(harness)).toBe(0);

    expect(harness.stdout.join('')).toBe('momonga 2.0.0 is up to date\n');
    expect(harness.server.requests).toHaveLength(1);
    expectUnchanged(harness);
  });

  it('with --check reports a newer release without downloading it', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);

    expect(await update(harness, true)).toBe(0);

    expect(harness.stdout.join('')).toBe('momonga 2.0.0 is available (running 1.0.0); run `momonga update` to install it\n');
    expect(harness.server.requests).toHaveLength(1);
    expectUnchanged(harness);
  });
});

describe('momonga update: failures keep the installed binary intact', () => {
  it('removes the staging file when the download is interrupted mid-body', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);
    const asset = harness.server.files.get(`v2.0.0/${assetOf(harness)}`);
    if (asset === undefined) throw new Error('asset was not published');
    asset.interruptAfterBytes = 7;

    const error = await expectRejected(harness, 'download_failed');

    expect(error.message).toContain('downloading the release executable was interrupted');
    expectUnchanged(harness);
    expect(harness.runs).toEqual([]);
  });

  it('reports a missing asset as a failed download', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);
    harness.server.files.delete(`v2.0.0/${assetOf(harness)}`);

    const error = await expectRejected(harness, 'download_failed');

    expect(error.message).toContain('HTTP 404');
    expectUnchanged(harness);
  });

  it('reports a failing release lookup, a malformed answer and a malformed tag with their own codes', async (context) => {
    const harness = await setupUpdate(context);

    harness.server.latestStatus = 500;
    await expectRejected(harness, 'release_lookup_failed');

    harness.server.latestStatus = 200;
    harness.server.latestBody = 'not json';
    await expectRejected(harness, 'release_malformed');

    harness.server.latestBody = JSON.stringify({ name: 'x' });
    await expectRejected(harness, 'release_malformed');

    harness.server.latestBody = undefined;
    harness.server.latestTag = 'latest';
    await expectRejected(harness, 'version_malformed');

    harness.server.latestTag = 'v2.0';
    await expectRejected(harness, 'version_malformed');
    expectUnchanged(harness);
  });

  it('refuses to run beside another update and touches neither network nor binary', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);
    harness.control.lockHeld = true;

    await expectRejected(harness, 'update_in_progress');

    expect(harness.server.requests).toHaveLength(1);
    expectUnchanged(harness);
  });

  it('releases the update lock after a failure', async (context) => {
    const harness = await setupUpdate(context);
    harness.server.publish('v2.0.0', { [assetOf(harness)]: NEW_BINARY }, { checksums: undefined });

    await expectRejected(harness, 'checksums_unavailable');

    expect(harness.released.count).toBe(1);
  });

  it('reports an install directory that cannot be written with a typed error and the cause, without falling back elsewhere', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);
    fs.chmodSync(harness.dir, 0o555);
    try {
      const error = await expectRejected(harness, 'install_directory_not_writable');
      expect(error.message).toContain(harness.dir);
      expect(error.detail).toMatch(/^EACCES: /);
      expect(error.remediation).toContain('install script');
      expect(error.cause).toMatchObject({ code: 'EACCES' });
    } finally {
      fs.chmodSync(harness.dir, 0o755);
    }
    expectUnchanged(harness);
  });

  it('keeps the reason of a failed update when the staging file cannot be removed either, and says so', async (context) => {
    const harness = await setupUpdate(context);
    harness.server.publish('v2.0.0', { [assetOf(harness)]: NEW_BINARY }, { checksums: checksumListing({ [assetOf(harness)]: OLD_BINARY }) });
    const remove = harness.ports.fs.remove;
    harness.ports.fs.remove = async () => {
      throw new Error('the volume went away');
    };

    const error = await expectRejected(harness, 'checksum_mismatch');

    expect(error.message).toContain('does not match SHA256SUMS');
    expect(harness.stderr.join('')).toMatch(/momonga: the staging file .*\.momonga-update\..* could not be removed: the volume went away\n/);
    for (const entry of fs.readdirSync(harness.dir)) if (entry.startsWith('.momonga-update.')) await remove(path.join(harness.dir, entry));
  });

  it('stops at an aborted signal without installing', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);
    const controller = new AbortController();
    controller.abort(new Error('interrupted'));

    await expect(runUpdate(harness.wiring, { write: () => undefined }, { checkOnly: false, interrupt: controller.signal })).rejects.toThrow('interrupted');

    expectUnchanged(harness);
  });
});

describe('momonga update: the daemon after the update', () => {
  it('restarts a running daemon by running the new executable, after the replacement', async (context) => {
    const harness = await setupUpdate(context);
    harness.control.daemonRunning = true;
    publish(harness);

    await update(harness);

    const restart = harness.runs.find((call) => call.args[0] === 'daemon');
    expect(restart?.file).toBe(harness.target);
    expect(restart?.args).toEqual(['daemon', 'start']);
    expect(restart?.targetContent).toBe(NEW_BINARY.toString());
    expect(harness.stdout.join('')).toContain('restarted the daemon on the new version');
  });

  it('lets the interrupt stop the signature check, the candidate check and the restart, and bounds the restart', async (context) => {
    const harness = await setupUpdate(context, darwin);
    harness.control.daemonRunning = true;
    publish(harness);
    const controller = new AbortController();

    await runUpdate(harness.wiring, { write: () => undefined }, { checkOnly: false, interrupt: controller.signal });

    expect(harness.runs.map((call) => call.options.signal)).toEqual([controller.signal, controller.signal, controller.signal]);
    expect(harness.runs.at(-1)?.options.timeoutMs).toBe(DAEMON_RESTART_BOUND_MS);
  });

  it('does not start a daemon that was not running', async (context) => {
    const harness = await setupUpdate(context);
    publish(harness);

    await update(harness);

    expect(harness.runs.some((call) => call.args[0] === 'daemon')).toBe(false);
    expect(harness.stdout.join('')).not.toContain('daemon');
  });

  it('reports a daemon that fails to restart while the new binary stays installed', async (context) => {
    const harness = await setupUpdate(context);
    harness.control.daemonRunning = true;
    harness.control.daemonStart = { exitCode: 1, stdout: '', stderr: 'supervisor exited' };
    publish(harness);

    const error = await expectRejected(harness, 'daemon_restart_failed');

    expect(error.detail).toBe('supervisor exited');
    expect(error.remediation).toBe('run `momonga daemon start`');
    expect(harness.targetBytes().equals(NEW_BINARY)).toBe(true);
  });

  it('does not restart the daemon when the update itself failed', async (context) => {
    const harness = await setupUpdate(context);
    harness.control.daemonRunning = true;
    harness.server.publish('v2.0.0', { [assetOf(harness)]: NEW_BINARY }, { checksums: checksumListing({ [assetOf(harness)]: OLD_BINARY }) });

    await expectRejected(harness, 'checksum_mismatch');

    expect(harness.runs).toEqual([]);
  });
});

describe('momonga update: builds that cannot update', () => {
  it('refuses to replace node when run from source, before looking at the update source', async (context) => {
    const harness = await setupUpdate(context, { scripted: true, build: { repo: undefined, teamId: undefined } });

    const error = await expectRejected(harness, 'not_single_executable');

    expect(error.message).toContain('running from source under node');
    expect(error.detail).toBe(harness.target);
    expect(harness.server.requests).toEqual([]);
    expectUnchanged(harness);
  });

  it('reports a typed error naming MOMONGA_REPO when the build has no repository', async (context) => {
    const harness = await setupUpdate(context, { build: { repo: undefined, teamId: undefined } });

    const error = await expectRejected(harness, 'no_update_source');

    expect(error.message).toBe('this build has no update source: it was built without MOMONGA_REPO');
    expect(error.remediation).toContain('MOMONGA_REPO=<owner>/<repo>');
    expect(harness.server.requests).toEqual([]);
  });

  it('reports a typed error naming MOMONGA_TEAM_ID on macOS builds without a team', async (context) => {
    const harness = await setupUpdate(context, { ...darwin, build: { repo: 'acme/momonga', teamId: undefined } });

    const error = await expectRejected(harness, 'no_update_source');

    expect(error.message).toContain('MOMONGA_TEAM_ID');
    expect(harness.server.requests).toEqual([]);
  });

  it('does not need a team on Linux', async (context) => {
    const harness = await setupUpdate(context, { build: { repo: 'acme/momonga', teamId: undefined } });
    publish(harness);

    expect(await update(harness)).toBe(0);
  });

  it('rejects malformed build inputs instead of using them', async (context) => {
    const repo = await setupUpdate(context, { build: { repo: 'no-slash', teamId: undefined } });
    await expectRejected(repo, 'invalid_update_source');
    const team = await setupUpdate(context, { ...darwin, build: { repo: 'acme/momonga', teamId: 'abc' } });
    await expectRejected(team, 'invalid_update_source');
  });

  it('has no release asset for Windows or other architectures', async (context) => {
    const windows = await setupUpdate(context, { platform: 'win32', arch: 'x64' });
    const error = await expectRejected(windows, 'unsupported_platform');
    expect(error.message).toBe('self-update has no release asset for win32/x64');
    const intel = await setupUpdate(context, { ...darwin, arch: 'x64' });
    await expectRejected(intel, 'unsupported_platform');
  });
});
