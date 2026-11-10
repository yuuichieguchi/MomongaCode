import { execFileSync, spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { readPinnedReleaseKey, verifyWithPinnedKey } from './release-key.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const SIGNATURE_NAMESPACE = 'momonga-release';

const generateKey = (directory: string, name: string): { privateKey: string; publicKey: string } => {
  const privateKey = path.join(directory, name);
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', privateKey]);
  return { privateKey, publicKey: fs.readFileSync(`${privateKey}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ') };
};

describe('release-key.ts', () => {
  let root = '';
  let release = { privateKey: '', publicKey: '' };
  let attacker = { privateKey: '', publicKey: '' };
  let instances = 0;

  const repoPinning = (shellKey: string, powershellKey: string): string => {
    instances += 1;
    const repo = path.join(root, `repo-${instances}`);
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts/install.sh'), `#!/bin/bash\nreadonly SIGNATURE_NAME="SHA256SUMS.sig"\nreadonly EMBEDDED_RELEASE_PUBLIC_KEY="${shellKey}"\n`);
    fs.writeFileSync(path.join(repo, 'scripts/install.ps1'), `$signatureName = 'SHA256SUMS.sig'\n$embeddedReleasePublicKey = '${powershellKey}'\n`);
    return repo;
  };

  const signed = (sums: string, key = release.privateKey): { checksums: string; signature: string } => {
    instances += 1;
    const checksums = path.join(root, `sums-${instances}`);
    fs.writeFileSync(checksums, sums);
    execFileSync('/usr/bin/ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', SIGNATURE_NAMESPACE, checksums]);
    return { checksums, signature: `${checksums}.sig` };
  };

  beforeAll(() => {
    root = createTempRoot();
    release = generateKey(root, 'release_key');
    attacker = generateKey(root, 'attacker_key');
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('refuses a repository whose installers pin no release key, and says what to put where', () => {
    expect(() => readPinnedReleaseKey(repoPinning('', ''))).toThrow('put the public key of RELEASE_SIGNING_KEY');
    expect(() => readPinnedReleaseKey(repoPinning('', ''))).toThrow('ssh-keygen -y -f <RELEASE_SIGNING_KEY>');
  });

  it('refuses installers that pin different keys', () => {
    expect(() => readPinnedReleaseKey(repoPinning(release.publicKey, attacker.publicKey))).toThrow('pin different release public keys');
    expect(() => readPinnedReleaseKey(repoPinning(release.publicKey, ''))).toThrow('pin different release public keys');
  });

  it('refuses a pinned value that is not one ssh public key line', () => {
    expect(() => readPinnedReleaseKey(repoPinning('not a key', 'not a key'))).toThrow('not one ssh public key line');
  });

  it('reads the key both installers pin', () => {
    expect(readPinnedReleaseKey(repoPinning(release.publicKey, release.publicKey))).toBe(release.publicKey);
  });

  it('reads a declaration indented by the structure of the installer', () => {
    const repo = repoPinning(release.publicKey, release.publicKey);
    fs.writeFileSync(path.join(repo, 'scripts/install.ps1'), `& {\n  $signatureName = 'SHA256SUMS.sig'\n  $embeddedReleasePublicKey = '${release.publicKey}'\n}\n`);
    expect(readPinnedReleaseKey(repo)).toBe(release.publicKey);
  });

  it('refuses an installer that declares the value twice', () => {
    const repo = repoPinning(release.publicKey, release.publicKey);
    fs.appendFileSync(path.join(repo, 'scripts/install.ps1'), `  $embeddedReleasePublicKey = '${release.publicKey}'\n`);
    expect(() => readPinnedReleaseKey(repo)).toThrow('scripts/install.ps1 has 2 embedded release declarations');
  });

  it('refuses an installer that does not declare the value', () => {
    const repo = repoPinning(release.publicKey, release.publicKey);
    fs.writeFileSync(path.join(repo, 'scripts/install.sh'), '#!/bin/bash\n');
    expect(() => readPinnedReleaseKey(repo)).toThrow('scripts/install.sh has no embedded release declaration');
  });

  it('reads the installers of this repository, which pin no key until the maintainers choose one', () => {
    expect(() => readPinnedReleaseKey(repoRoot)).toThrow('no release signing key is pinned');
  });

  it('accepts a signature made by the pinned key', async () => {
    const { checksums, signature } = signed('f'.repeat(64) + '  momonga-darwin-arm64\n');
    await expect(verifyWithPinnedKey(repoPinning(release.publicKey, release.publicKey), checksums, signature)).resolves.toBeUndefined();
  });

  it('rejects a signature made by another key and one over altered checksums', async () => {
    const pinned = repoPinning(release.publicKey, release.publicKey);
    const foreign = signed('a'.repeat(64) + '  momonga-darwin-arm64\n', attacker.privateKey);
    await expect(verifyWithPinnedKey(pinned, foreign.checksums, foreign.signature)).rejects.toThrow('is not signed by the release key pinned in the installers');
    const genuine = signed('b'.repeat(64) + '  momonga-darwin-arm64\n');
    fs.writeFileSync(genuine.checksums, 'c'.repeat(64) + '  momonga-darwin-arm64\n');
    await expect(verifyWithPinnedKey(pinned, genuine.checksums, genuine.signature)).rejects.toThrow('refusing to publish');
  });

  it('exits non-zero from the command line when the pin is missing', () => {
    const result = spawnSync(process.execPath, [`${repoRoot}scripts/release-key.ts`, 'print'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release-key.ts: no release signing key is pinned');
    expect(result.stdout).toBe('');
  });

  it('prints yuuichieguchi/MomongaCode as the release repository from the command line', () => {
    const result = spawnSync(process.execPath, [`${repoRoot}scripts/release-key.ts`, 'print-repo'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('yuuichieguchi/MomongaCode\n');
  });
});
