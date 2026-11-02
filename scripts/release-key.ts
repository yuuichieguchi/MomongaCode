import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_PUBLIC_KEY_PATTERN, RELEASE_SIGNATURE_TOOL, nodeCommandRunner, verifyReleaseSignature } from '@momonga/foundation';
import type { PlaceFile } from '@momonga/foundation';

const SHELL_INSTALLER = 'scripts/install.sh';
const POWERSHELL_INSTALLER = 'scripts/install.ps1';

const SHELL_PIN = /^readonly EMBEDDED_RELEASE_PUBLIC_KEY="([^"\n]*)"$/m;
const POWERSHELL_PIN = /^\$embeddedReleasePublicKey = '([^'\n]*)'$/m;

const pinIn = (root: string, installer: string, pattern: RegExp): string => {
  const match = pattern.exec(fs.readFileSync(path.join(root, installer), 'utf8'));
  if (match === null) throw new Error(`${installer} has no embedded release public key declaration`);
  return match[1] as string;
};

export const readPinnedReleaseKey = (root: string): string => {
  const shell = pinIn(root, SHELL_INSTALLER, SHELL_PIN);
  const powershell = pinIn(root, POWERSHELL_INSTALLER, POWERSHELL_PIN);
  if (shell === '' && powershell === '') {
    throw new Error(
      `no release signing key is pinned in ${SHELL_INSTALLER} and ${POWERSHELL_INSTALLER}: put the public key of RELEASE_SIGNING_KEY (the output of \`ssh-keygen -y -f <RELEASE_SIGNING_KEY>\`) ` +
        'into EMBEDDED_RELEASE_PUBLIC_KEY in install.sh and $embeddedReleasePublicKey in install.ps1, then commit',
    );
  }
  if (shell !== powershell) throw new Error(`${SHELL_INSTALLER} and ${POWERSHELL_INSTALLER} pin different release public keys; both must hold the same key line`);
  if (!RELEASE_PUBLIC_KEY_PATTERN.test(shell)) throw new Error(`the release public key pinned in the installers is not one ssh public key line: ${JSON.stringify(shell)}`);
  return shell;
};

const placeInDirectory =
  (directory: string): PlaceFile =>
  async (content) => {
    const file = path.join(directory, `file-${fs.readdirSync(directory).length}`);
    fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    return { path: file, remove: async () => fs.rmSync(file) };
  };

export const verifyWithPinnedKey = async (root: string, checksumsFile: string, signatureFile: string): Promise<void> => {
  const publicKey = readPinnedReleaseKey(root);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-release-verify-'));
  try {
    const verdict = await verifyReleaseSignature({
      run: nodeCommandRunner,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      place: placeInDirectory(directory),
      publicKey,
      checksums: fs.readFileSync(checksumsFile, 'utf8'),
      signature: fs.readFileSync(signatureFile, 'utf8'),
    });
    if (verdict.kind === 'invalid') {
      throw new Error(`${checksumsFile} is not signed by the release key pinned in the installers; refusing to publish${verdict.detail === '' ? '' : `: ${verdict.detail}`}`);
    }
    if (verdict.kind === 'tool_unusable') {
      throw new Error(`${RELEASE_SIGNATURE_TOOL} cannot verify signatures on this machine, so ${checksumsFile} was not checked; upgrade OpenSSH${verdict.detail === '' ? '' : `: ${verdict.detail}`}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..');
  const [command, checksumsFile, signatureFile] = process.argv.slice(2);
  try {
    if (command === 'print') {
      process.stdout.write(`${readPinnedReleaseKey(root)}\n`);
    } else if (command === 'verify' && checksumsFile !== undefined && signatureFile !== undefined) {
      await verifyWithPinnedKey(root, checksumsFile, signatureFile);
    } else {
      throw new Error('usage: release-key.ts print | release-key.ts verify <SHA256SUMS> <SHA256SUMS.sig>');
    }
  } catch (error) {
    process.stderr.write(`release-key.ts: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
