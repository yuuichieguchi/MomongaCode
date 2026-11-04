import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_SIGNATURE_ASSET, RELEASE_SIGNATURE_NAMESPACE } from '@momonga/foundation';
import { SEA_TARGETS } from '../scripts/node-runtime.ts';
import { CHECKSUMS_ASSET, GITHUB_ENDPOINTS, assetNameFor } from '../packages/cli/src/update/source.ts';
import { parseReleaseTag } from '../packages/cli/src/update/version.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('the updater consumes the assets the release script publishes', () => {
  it.each([
    ['darwin', 'arm64', 'darwin-arm64'],
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
  ] as const)('%s/%s downloads the asset built for the %s target', (platform, arch, target) => {
    expect(assetNameFor(platform, arch)).toBe(SEA_TARGETS[target].assetName);
  });

  it('names the checksum listing like release.sh and install.sh', () => {
    for (const script of ['scripts/release.sh', 'scripts/install.sh']) {
      expect(fs.readFileSync(path.join(root, script), 'utf8')).toContain(`readonly CHECKSUMS_NAME="${CHECKSUMS_ASSET}"`);
    }
  });

  it('names the signature asset and its namespace like release.sh, install.sh and install.ps1', () => {
    for (const script of ['scripts/release.sh', 'scripts/install.sh']) {
      const source = fs.readFileSync(path.join(root, script), 'utf8');
      expect(source).toContain(`readonly SIGNATURE_NAME="${RELEASE_SIGNATURE_ASSET}"`);
      expect(source).toContain(`readonly SIGNATURE_NAMESPACE="${RELEASE_SIGNATURE_NAMESPACE}"`);
    }
    const powershell = fs.readFileSync(path.join(root, 'scripts/install.ps1'), 'utf8');
    expect(powershell).toContain(`$signatureName = '${RELEASE_SIGNATURE_ASSET}'`);
    expect(powershell).toContain(`$signatureNamespace = '${RELEASE_SIGNATURE_NAMESPACE}'`);
  });

  it('fetches from the same release URL layout as install.sh', () => {
    const updaterTemplate = /const releaseUrl = [^`]*`([^`]+)`/.exec(fs.readFileSync(path.join(root, 'packages/cli/src/update/install.ts'), 'utf8'))?.[1];
    const installerTemplate = /base_url="(https:\/\/[^"]*\/releases\/download\/[^"]*)"/.exec(fs.readFileSync(path.join(root, 'scripts/install.sh'), 'utf8'))?.[1];

    const updaterLayout = updaterTemplate
      ?.replace('${source.endpoints.downloadBaseUrl}', GITHUB_ENDPOINTS.downloadBaseUrl)
      .replace('${source.repo}', '<repo>')
      .replace('${release.tag}', '<tag>')
      .replace('/${name}', '');
    const installerLayout = installerTemplate?.replace('$repo', '<repo>').replace('v$MOMONGA_VERSION', '<tag>');

    expect(updaterLayout).toBe('https://github.com/<repo>/releases/download/<tag>');
    expect(installerLayout).toBe(updaterLayout);
    expect(parseReleaseTag('v1.2.3').text).toBe('1.2.3');
  });
});
