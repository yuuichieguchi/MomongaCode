import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const STUB_SOURCES: Record<string, string> = {
  npm: `output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then output="$2"; fi
  shift
done
printf '#!/bin/sh\\necho 0.0.0\\n' > "$output"
chmod 755 "$output"`,
  ditto: `for last; do :; done
: > "$last"`,
  xcrun: `printf '{"id":"fake-submission","status":"%s"}\\n' "\${STUB_NOTARY_STATUS:-Accepted}"`,
  spctl: `exit "\${STUB_SPCTL_EXIT:-0}"`,
  codesign: ``,
  gh: ``,
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

describe('release.sh', () => {
  let root = '';
  let stubs = '';
  let work = '';
  let origin = '';
  let log = '';
  let keyFile = '';

  const commit = (subject: string): void => {
    fs.writeFileSync(path.join(work, 'change.txt'), subject);
    git(work, 'add', '-A');
    git(work, 'commit', '-m', subject);
  };

  const releaseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...gitEnv(),
    PATH: `${stubs}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    STUB_LOG: log,
    SIGNING_IDENTITY: 'Developer ID Application: Fake Person (FAKE000000)',
    APPLE_API_KEY: keyFile,
    APPLE_API_KEY_ID: 'FAKEKEYID1',
    APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
    MOMONGA_REPO: 'fake-owner/fake-repo',
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
    fs.writeFileSync(path.join(work, 'packages/cli/package.json'), JSON.stringify({ name: 'momonga', version: '1.2.3' }));
    fs.writeFileSync(path.join(work, '.gitignore'), 'dist/\n');
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
      'mkdir -p',
      'npm run',
      'codesign --sign',
      'codesign --verify',
      `${work}/dist/release/momonga-darwin-arm64 --version`,
      'rm -f',
      'ditto -c',
      'xcrun notarytool',
      'spctl --assess',
      'write_checksums',
      'git tag',
      'git push',
      'gh release',
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
      'codesign --sign',
      'codesign --verify',
      'ditto -c',
      'xcrun notarytool',
      'spctl --assess',
      'gh release',
    ]);
    expect(calls[0]).toBe(`npm run sea -- --unsigned --output ${binary} `);
    expect(calls[1]).toBe(
      `codesign --sign Developer ID Application: Fake Person (FAKE000000) --force --timestamp --options runtime --entitlements ${work}/scripts/sea-entitlements.plist ${binary} `,
    );
    expect(calls[2]).toBe(`codesign --verify --strict --verbose=2 ${binary} `);
    expect(calls[4]).toBe(
      `xcrun notarytool submit ${binary}.zip --key ${keyFile} --key-id FAKEKEYID1 --issuer 00000000-0000-0000-0000-000000000000 --wait --output-format json `,
    );
    expect(calls[5]).toBe(`spctl --assess --type execute --verbose=4 ${binary} `);
    expect(calls[6]).toContain(`gh release create v1.2.3 ${binary} ${work}/dist/release/SHA256SUMS --repo fake-owner/fake-repo --verify-tag --title v1.2.3 --notes - second change (`);
    expect(originTags()).toBe('v1.2.3\n');
    expect(fs.readFileSync(`${work}/dist/release/SHA256SUMS`, 'utf8')).toMatch(/^[0-9a-f]{64} {2}momonga-darwin-arm64\n$/);
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
    expect(loggedNames()).toEqual(['npm', 'codesign', 'codesign', 'ditto', 'xcrun', 'spctl']);
    expect(originTags()).toBe('');
    expect(fs.existsSync(`${work}/dist/release/SHA256SUMS`)).toBe(false);
  });

  it('stops when notarization is not accepted', () => {
    commit('second change');
    const result = release({ STUB_NOTARY_STATUS: 'Invalid' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('release.sh: notarization was not accepted\n');
    expect(loggedNames()).toEqual(['npm', 'codesign', 'codesign', 'ditto', 'xcrun']);
    expect(originTags()).toBe('');
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

  it('rejects an invalid DRY_RUN value', () => {
    const result = release({ DRY_RUN: 'yes' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("release.sh: DRY_RUN must be 0 or 1, got 'yes'\n");
  });
});
