const SOCKET_GUARD_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['linux']);

export const hasSocketGuard = (platform: NodeJS.Platform): boolean => SOCKET_GUARD_PLATFORMS.has(platform);
