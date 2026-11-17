export type OpenLockFlags = { readonly shared: number; readonly exclusive: number };

export const HOST_PLATFORM: string = process.platform;

const OPEN_LOCK_FLAGS = new Map<string, OpenLockFlags>([['darwin', { shared: 0x10, exclusive: 0x20 }]]);

export const openLockFlagsOn = (platform: string): OpenLockFlags | undefined => OPEN_LOCK_FLAGS.get(platform);
