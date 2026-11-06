export const RELEASE_ASSETS = {
  'darwin-arm64': 'momonga-darwin-arm64',
  'linux-x64': 'momonga-linux-x64',
  'linux-arm64': 'momonga-linux-arm64',
  'win-x64': 'momonga-win-x64.exe',
} as const;

export type ReleaseTargetName = keyof typeof RELEASE_ASSETS;

export const releaseTargetOf = (platform: NodeJS.Platform, arch: string): ReleaseTargetName | undefined => {
  const name = `${platform === 'win32' ? 'win' : platform}-${arch}`;
  return Object.hasOwn(RELEASE_ASSETS, name) ? (name as ReleaseTargetName) : undefined;
};
