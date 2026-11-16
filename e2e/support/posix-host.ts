const POSIX_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['darwin', 'linux']);

export const requirePosixHost = (helper: string, platform: NodeJS.Platform = process.platform): void => {
  if (!POSIX_PLATFORMS.has(platform)) throw new Error(`${helper} runs on macOS and Linux only; this host is ${platform}`);
};
