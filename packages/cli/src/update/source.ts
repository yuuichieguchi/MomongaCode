import { RELEASE_CHECKSUMS_ASSET, RELEASE_PUBLIC_KEY_PATTERN } from '@momonga/foundation';
import { UpdateError } from './errors.ts';

export type BuildUpdateInputs = { repo: string | undefined; teamId: string | undefined; publicKey: string | undefined };

export type UpdateEndpoints = { apiBaseUrl: string; downloadBaseUrl: string };

export const GITHUB_ENDPOINTS: UpdateEndpoints = { apiBaseUrl: 'https://api.github.com', downloadBaseUrl: 'https://github.com' };

export type CodesignRequirement = { kind: 'none' } | { kind: 'apple-team'; teamId: string };

export type UpdateSource = { repo: string; publicKey: string; codesign: CodesignRequirement; endpoints: UpdateEndpoints };

export const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
export const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
export { RELEASE_PUBLIC_KEY_PATTERN };

export const CHECKSUMS_ASSET = RELEASE_CHECKSUMS_ASSET;

const ASSET_BY_TARGET: Readonly<Record<string, string>> = {
  'darwin-arm64': 'momonga-darwin-arm64',
  'linux-x64': 'momonga-linux-x64',
  'linux-arm64': 'momonga-linux-arm64',
};

export const assetNameFor = (platform: NodeJS.Platform, arch: string): string => {
  const asset = ASSET_BY_TARGET[`${platform}-${arch}`];
  if (asset === undefined) {
    throw new UpdateError('unsupported_platform', `self-update has no release asset for ${platform}/${arch}`, {
      remediation: 'reinstall with the install script for this platform',
    });
  }
  return asset;
};

export const resolveUpdateSource = (inputs: BuildUpdateInputs, endpoints: UpdateEndpoints, platform: NodeJS.Platform): UpdateSource => {
  const { repo, teamId, publicKey } = inputs;
  if (repo === undefined) {
    throw new UpdateError('no_update_source', 'this build has no update source: it was built without MOMONGA_REPO', {
      remediation: 'install a release build, or rebuild with MOMONGA_REPO=<owner>/<repo>, MOMONGA_RELEASE_PUBLIC_KEY (and MOMONGA_TEAM_ID on macOS)',
    });
  }
  if (!REPO_PATTERN.test(repo)) throw new UpdateError('invalid_update_source', 'MOMONGA_REPO of this build is not <owner>/<repo>', { detail: JSON.stringify(repo) });
  if (publicKey === undefined) {
    throw new UpdateError('no_update_source', 'this build has no update source: it was built without MOMONGA_RELEASE_PUBLIC_KEY, which release signature verification requires', {
      remediation: 'install a release build, or rebuild with MOMONGA_RELEASE_PUBLIC_KEY=<the ssh public key pinned in scripts/install.sh>',
    });
  }
  if (!RELEASE_PUBLIC_KEY_PATTERN.test(publicKey)) {
    throw new UpdateError('invalid_update_source', 'MOMONGA_RELEASE_PUBLIC_KEY of this build is not an ssh public key line', { detail: JSON.stringify(publicKey) });
  }
  if (platform !== 'darwin') return { repo, publicKey, codesign: { kind: 'none' }, endpoints };
  if (teamId === undefined) {
    throw new UpdateError('no_update_source', 'this build has no update source: it was built without MOMONGA_TEAM_ID, which macOS signature verification requires', {
      remediation: 'install a release build, or rebuild with MOMONGA_TEAM_ID=<Apple Team ID>',
    });
  }
  if (!TEAM_ID_PATTERN.test(teamId)) {
    throw new UpdateError('invalid_update_source', 'MOMONGA_TEAM_ID of this build is not a 10-character Apple Team ID', { detail: JSON.stringify(teamId) });
  }
  return { repo, publicKey, codesign: { kind: 'apple-team', teamId }, endpoints };
};
