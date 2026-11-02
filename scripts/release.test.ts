import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';

const STUB_SOURCES: Record<string, string> = {
  npm: `case " $* " in *" \${STUB_NPM_FAIL:-no-such-script} "*) exit 1 ;; esac
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then output="$2"; fi
  shift
done
if [ -n "$output" ]; then
  case "$output" in
    *.exe) printf 'MZ stub' > "$output" ;;
    *linux*) if [ "\${STUB_LINUX_NOT_ELF:-0}" = "1" ]; then printf 'not elf' > "$output"; else printf '\\177ELF stub' > "$output"; fi ;;
    *) printf '#!/bin/sh\\necho "%s"\\n' "\${STUB_BINARY_VERSION:-1.2.3}" > "$output" ;;
  esac
  chmod 755 "$output"
fi`,
  ditto: `for last; do :; done
: > "$last"`,
  xcrun: `printf '{"id":"fake-submission","status":"%s"}\\n' "\${STUB_NOTARY_STATUS:-Accepted}"`,
  spctl: `exit "\${STUB_SPCTL_EXIT:-0}"`,
  codesign: `if [ "$1" = "--display" ]; then printf 'Authority=Developer ID\\nTeamIdentifier=%s\\n' "\${STUB_TEAM_ID:-FAKE000000}" >&2; fi`,
  'ssh-keygen': `case " $* " in *" verify "*) exit "\${STUB_SSH_VERIFY_EXIT:-0}" ;; esac
for last; do :; done
printf 'signature' > "$last.sig"`,
  gh: `case "$1 $2" in
  "release edit")
    if [ "\${STUB_GH_FAIL_ON:-}" = "edit" ]; then exit 1; fi
    /usr/bin/git --git-dir "$STUB_ORIGIN" tag "$3" "$(/usr/bin/git --git-dir "$STUB_ORIGIN" rev-parse refs/heads/main)" ;;
  "release create") if [ "\${STUB_GH_FAIL_ON:-}" = "create" ]; then exit 1; fi ;;
esac`,
};

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Release Test',
  GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
  GIT_COMMITTER_NAME: 'Release Test',
  GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
});

const PINNED_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

const installers = (key: string): Record<string, string> => ({
  'scripts/install.sh': `#!/bin/bash\nreadonly EMBEDDED_RELEASE_PUBLIC_KEY="${key}"\n`,
  'scripts/install.ps1': `$embeddedReleasePublicKey = '${key}'\n`,
});

const CHECKS = ['npm', 'npm', 'npm', 'npm'];
const BUILT = [...CHECKS, 'npm'];

describe.skipIf(!HAS_POSIX_SHELL)('release.sh', () => {
  let root = '';
  let stubs = '';
  let work = '';
  let origin = '';
  let log = '';
  let keyFile = '';
  let signingKey = '';

  const commitLocally = (subject: string): void => {
    fs.writeFileSync(path.join(work, 'change.txt'), subject);
    git(work, 'add', '-A');
    git(work, 'commit', '-m', subject);
  };

  const commit = (subject: string): void => {
    commitLocally(subject);
    git(work, 'push', '--quiet', 'origin', 'main');
  };

  const releaseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...gitEnv(),
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_LOG: log,
    STUB_ORIGIN: origin,
    SIGNING_IDENTITY: 'Developer ID Application: Fake Person (FAKE000000)',
    APPLE_API_KEY: keyFile,
    RELEASE_SIGNING_KEY: signingKey,
    APPLE_API_KEY_ID: 'FAKEKEYID1',
    APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
    MOMONGA_REPO: 'fake-owner/fake-repo',
    MOMONGA_TEAM_ID: 'FAKE000000',
    ...extra,
  });

  const release = (extra: NodeJS.ProcessEnv = {}) =>
    spawnSync('/bin/bash', [path.join(work, 'scripts/release.sh')], { cwd: work, encoding: 'utf8', env: releaseEnv(extra) });

  const loggedCalls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0) : []);
  const loggedNames = (): string[] => loggedCalls().map((line) => line.split(' ')[0] as string);
  const originTags = (): string => git(origin, 'tag', '--list');

  beforeAll(() => {
    root = createTempRoot();
    stubs = path.join(root, 'stubs');
    fs.mkdirSync(stubs);
    for (const [name, body] of Object.entries(STUB_SOURCES)) {
      fs.writeFileSync(
        path.join(stubs, name),
        `#!/bin/sh\nprintf '%s %s\\n' "$(basename "$0")" "$(printf '%s ' "$@" | tr '\\n' '~')" >> "$STUB_LOG"\n${body}\n`,
        { mode: 0o755 },
      );
    }
    keyFile = path.join(root, 'AuthKey_FAKEKEYID1.p8');
    fs.writeFileSync(keyFile, 'fake key material');
    signingKey = path.join(root, 'release_signing_key');
    fs.writeFileSync(signingKey, 'fake ssh key');
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  beforeEach(() => {
    const instance = fs.mkdtempSync(path.join(root, 'repo-'));
    work = path.join(instance, 'work');
    origin = path.join(instance, 'origin.git');
    log = path.join(instance, 'stub.log');
    git(instance, 'init', '--bare', '--initial-branch=main', origin);
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(work, 'packages/cli'), { recursive: true });
    fs.copyFileSync(`${repoRoot}scripts/release.sh`, path.join(work, 'scripts/release.sh'));
    fs.copyFileSync(`${repoRoot}scripts/sea-entitlements.plist`, path.join(work, 'scripts/sea-entitlements.plist'));
    fs.copyFileSync(`${repoRoot}scripts/release-key.ts`, path.join(work, 'scripts/release-key.ts'));
    for (const [file, content] of Object.entries(installers(PINNED_KEY))) fs.writeFileSync(path.join(work, file), content);
    fs.symlinkSync(`${repoRoot}node_modules`, path.join(work, 'node_modules'));
    fs.writeFileSync(path.join(work, 'packages/cli/package.json'), JSON.stringify({ name: 'momonga', version: '1.2.3' }));
    fs.writeFileSync(path.join(work, '.gitignore'), 'dist/\nnode_modules\n');
    git(work, 'init', '--initial-branch=main');
    git(work, 'remote', 'add', 'origin', origin);
    commit('first change');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(work), { recursive: true, force: true });
  });

  it('dry run executes no external command and lists every step in order', () => {
    commit('second change');
    const result = release({ DRY_RUN: '1' });
    expect(result.status).toBe(0);
    expect(loggedCalls()).toEqual([]);
    expect(originTags()).toBe('');
    expect(git(work, 'tag', '--list')).toBe('');
    const effects = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('DRY_RUN: '))
      .map((line) => line.split(' ').slice(1, 3).join(' '));
    expect(effects).toEqual([
      'npm run',
      'npm test',
      'npm run',
      'npm run',
      'mkdir -p',
      'npm run',
      'codesign --sign',
      'codesign --verify',
      'codesign --display',
      `compare "${work}/dist/release/momonga-darwin-arm64`,
      'rm -f',
      'ditto -c',
      'xcrun notarytool',
      'spctl --assess',
      'npm run',
      'npm run',
      'npm run',
      `check ${work}/dist/release/momonga-linux-x64`,
      `check ${work}/dist/release/momonga-linux-arm64`,
      `check ${work}/dist/release/momonga-win-x64.exe`,
      'write_checksums',
      'rm -f',
      'ssh-keygen -Y',
      `node ${work}/scripts/release-key.ts`,
      'gh release',
      'gh release',
      'git fetch',
    ]);
    expect(result.stdout).toContain('- second change (');
    expect(result.stdout).toContain('- first change (');
  });

  it('live run with stubs performs the steps in the documented order', () => {
    commit('second change');
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    const binary = `${work}/dist/release/momonga-darwin-arm64`;
    const calls = loggedCalls();
    expect(calls.map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
      'npm run',
      'npm test',
      'npm run',
      'npm run',
      'npm run',
      'codesign --sign',
      'codesign --verify',
      'codesign --display',
      'ditto -c',
      'xcrun notarytool',
      'spctl --assess',
      'npm run',
      'npm run',
      'npm run',
      'ssh-keygen -Y',
      'ssh-keygen -Y',
      'gh release',
      'gh release',
    ]);
    expect(calls.slice(0, 4)).toEqual(['npm run typecheck ', 'npm test ', 'npm run test:e2e ', 'npm run test:packaging ']);
    const updateSourceFlags = `--repo fake-owner/fake-repo --team-id FAKE000000 --release-public-key ${PINNED_KEY} `;
    expect(calls[4]).toBe(`npm run sea -- --unsigned --output ${binary} ${updateSourceFlags}`);
    expect(calls[5]).toBe(
      `codesign --sign Developer ID Application: Fake Person (FAKE000000) --force --timestamp --options runtime --entitlements ${work}/scripts/sea-entitlements.plist ${binary} `,
    );
    expect(calls[6]).toBe(`codesign --verify --strict --verbose=2 ${binary} `);
    expect(calls[7]).toBe(`codesign --display --verbose=4 ${binary} `);
    expect(calls[9]).toBe(
      `xcrun notarytool submit ${binary}.zip --key ${keyFile} --key-id FAKEKEYID1 --issuer 00000000-0000-0000-0000-000000000000 --wait --output-format json `,
    );
    expect(calls[10]).toBe(`spctl --assess --type execute --verbose=4 ${binary} `);
    const out = `${work}/dist/release`;
    expect(calls.slice(11, 14)).toEqual(
      ['linux-x64', 'linux-arm64', 'win-x64'].map(
        (target) => `npm run sea -- --unsigned --target ${target} --output ${out}/momonga-${target}${target === 'win-x64' ? '.exe' : ''} ${updateSourceFlags}`,
      ),
    );
    expect(calls[14]).toBe(`ssh-keygen -Y sign -f ${signingKey} -n momonga-release ${out}/SHA256SUMS `);
    expect(calls[15]).toMatch(/^ssh-keygen -Y verify -f \S+ -I momonga-release -n momonga-release -s \S+ $/);
    expect(calls[16]).toContain(
      `gh release create v1.2.3 ${binary} ${out}/momonga-linux-x64 ${out}/momonga-linux-arm64 ${out}/momonga-win-x64.exe ${out}/SHA256SUMS ${out}/SHA256SUMS.sig --repo fake-owner/fake-repo --draft --target ${git(work, 'rev-parse', 'HEAD').trim()} --title v1.2.3 --notes - second change (`,
    );
    expect(calls[17]).toBe('gh release edit v1.2.3 --repo fake-owner/fake-repo --draft=false ');
    expect(originTags()).toBe('v1.2.3\n');
    expect(git(work, 'tag', '--list')).toBe('v1.2.3\n');
    const sums = fs.readFileSync(`${work}/dist/release/SHA256SUMS`, 'utf8').trimEnd().split('\n');
    expect(sums.map((line) => line.replace(/^[0-9a-f]{64} {2}/, ''))).toEqual(['momonga-darwin-arm64', 'momonga-linux-x64', 'momonga-linux-arm64', 'momonga-win-x64.exe']);
  });

  it('refuses to build or publish when the installers pin no release key, and says what to do', () => {
    for (const [file, content] of Object.entries(installers(''))) fs.writeFileSync(path.join(work, file), content);
    git(work, 'add', '-A');
    commit('unpin the release key');

    const result = release();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no release signing key is pinned in scripts/install.sh and scripts/install.ps1');
    expect(result.stderr).toContain('ssh-keygen -y -f <RELEASE_SIGNING_KEY>');
    expect(loggedCalls()).toEqual([]);
    expect(originTags()).toBe('');
  });

  it('refuses to build when the two installers pin different keys', () => {
    fs.writeFileSync(path.join(work, 'scripts/install.ps1'), installers(`${PINNED_KEY.slice(0, -4)}AAAA`)['scripts/install.ps1'] as string);
    commit('diverge the pins');

    const result = release();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pin different release public keys');
    expect(loggedCalls()).toEqual([]);
  });

  it('does not publish when the key pinned in the installers does not verify the signature it just made', () => {
    commit('second change');

    const result = release({ STUB_SSH_VERIFY_EXIT: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not signed by the release key pinned in the installers; refusing to publish');
    expect(loggedNames().slice(-2)).toEqual(['ssh-keygen', 'ssh-keygen']);
    expect(loggedNames()).not.toContain('gh');
    expect(originTags()).toBe('');
  });

  it('covers every commit when there is no previous tag', () => {
    commit('second change');
    expect(release().status).toBe(0);
    const notes = loggedCalls().find((line) => line.startsWith('gh '));
    expect(notes).toContain('- second change (');
    expect(notes).toContain('- first change (');
  });

  it('covers only the commits since the previous tag', () => {
    git(work, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    commit('second change');
    commit('third change');
    expect(release().status).toBe(0);
    const notes = loggedCalls().find((line) => line.startsWith('gh '));
    expect(notes).toContain('- third change (');
    expect(notes).toContain('- second change (');
    expect(notes).not.toContain('first change');
  });

  it('stops at a failed Gatekeeper assessment before publishing', () => {
    commit('second change');
    const result = release({ STUB_SPCTL_EXIT: '1' });
    expect(result.status).not.toBe(0);
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign', 'ditto', 'xcrun', 'spctl']);
    expect(originTags()).toBe('');
    expect(fs.existsSync(`${work}/dist/release/SHA256SUMS`)).toBe(false);
  });

  it('stops when notarization is not accepted', () => {
    commit('second change');
    const result = release({ STUB_NOTARY_STATUS: 'Invalid' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: notarization was not accepted\n');
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign', 'ditto', 'xcrun']);
    expect(originTags()).toBe('');
  });

  it('stops before notarization when the signed binary carries another Team ID', () => {
    commit('second change');
    const result = release({ STUB_TEAM_ID: 'OTHER00000' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: the signed binary does not carry TeamIdentifier=FAKE000000\n');
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign']);
    expect(originTags()).toBe('');
  });

  it('refuses to start without a Team ID', () => {
    const result = release({ MOMONGA_TEAM_ID: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: MOMONGA_TEAM_ID is not set\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses a malformed Team ID and a malformed repository before any command', () => {
    const teamId = release({ MOMONGA_TEAM_ID: 'lower-case' });
    expect(teamId.stderr).toBe("release.sh: MOMONGA_TEAM_ID must be a 10-character Apple Team ID, got 'lower-case'\n");
    const repo = release({ MOMONGA_REPO: 'no-slash' });
    expect(repo.stderr).toBe("release.sh: MOMONGA_REPO must be <owner>/<repo>, got 'no-slash'\n");
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses to start without a release signing key file', () => {
    const result = release({ RELEASE_SIGNING_KEY: path.join(root, 'missing-key') });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(`release.sh: RELEASE_SIGNING_KEY must be the path of the ssh private key that signs SHA256SUMS\n`);
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses to start without a credential', () => {
    const result = release({ APPLE_API_ISSUER: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: APPLE_API_ISSUER is not set\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses to start from a dirty working tree', () => {
    fs.writeFileSync(path.join(work, 'untracked.txt'), 'x');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: working tree is not clean\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses a tag that already exists', () => {
    git(work, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: tag v1.2.3 already exists\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('runs typecheck and every test project before building anything', () => {
    commit('second change');
    expect(release().status).toBe(0);
    expect(loggedCalls().slice(0, 4)).toEqual(['npm run typecheck ', 'npm test ', 'npm run test:e2e ', 'npm run test:packaging ']);
  });

  it.each(['typecheck', 'test', 'test:e2e', 'test:packaging'])('stops before building when %s fails', (script) => {
    commit('second change');
    const result = release({ STUB_NPM_FAIL: script });
    expect(result.status).not.toBe(0);
    expect(loggedNames().every((name) => name === 'npm')).toBe(true);
    expect(loggedCalls().some((line) => line.includes('sea'))).toBe(false);
    expect(originTags()).toBe('');
  });

  it('refuses to release from another branch', () => {
    git(work, 'checkout', '-q', '-b', 'feature');
    commitLocally('second change');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: releases are cut from main, not feature\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses a HEAD that origin does not have, so the release never carries unpushed commits', () => {
    commitLocally('unpushed change');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: HEAD is not origin/main; push or pull so that the release lands on a published commit\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('refuses a tag that origin already has even when the local clone does not', () => {
    git(work, 'tag', 'v1.2.3');
    git(work, 'push', '--quiet', 'origin', 'refs/tags/v1.2.3');
    git(work, 'tag', '--delete', 'v1.2.3');
    const result = release();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: tag v1.2.3 already exists on origin\n');
    expect(loggedCalls()).toEqual([]);
  });

  it('stops before notarization when the built binary reports another version than the tag', () => {
    commit('second change');
    const result = release({ STUB_BINARY_VERSION: '9.9.9' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("release.sh: the built binary reports version '9.9.9', not 1.2.3\n");
    expect(loggedNames()).toEqual([...BUILT, 'codesign', 'codesign', 'codesign']);
    expect(originTags()).toBe('');
  });

  it('stops before publishing when a built Linux executable is not an ELF file', () => {
    commit('second change');
    const result = release({ STUB_LINUX_NOT_ELF: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not an ELF executable');
    expect(loggedNames()).not.toContain('gh');
    expect(originTags()).toBe('');
  });

  it('publishes no tag when creating the draft release fails, and removes the draft it may have created', () => {
    commit('second change');
    const result = release({ STUB_GH_FAIL_ON: 'create' });
    expect(result.status).not.toBe(0);
    expect(originTags()).toBe('');
    expect(git(work, 'tag', '--list')).toBe('');
    expect(loggedCalls().at(-1)).toBe('gh release delete v1.2.3 --yes --repo fake-owner/fake-repo ');
  });

  it('deletes the draft and tags nothing when publishing it fails, so that a rerun starts clean', () => {
    commit('second change');
    const result = release({ STUB_GH_FAIL_ON: 'edit' });
    expect(result.status).not.toBe(0);
    expect(originTags()).toBe('');
    expect(loggedCalls().at(-1)).toBe('gh release delete v1.2.3 --yes --repo fake-owner/fake-repo ');
    fs.rmSync(log, { force: true });
    expect(release().status).toBe(0);
    expect(originTags()).toBe('v1.2.3\n');
  });

  it('rejects an invalid DRY_RUN value', () => {
    const result = release({ DRY_RUN: 'yes' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("release.sh: DRY_RUN must be 0 or 1, got 'yes'\n");
  });
});
