import fs from 'node:fs';

export const SMALL_FS_ENV = 'MOMONGA_INJECT_SMALL_FS';
export const SMALL_FILESYSTEM_MAX_BYTES = 256 * 1024 * 1024;

export type InjectionHost = { linuxContainer: true; smallFsBase: string } | { linuxContainer: false; reason: string };

export type InjectionHostPorts = {
  platform: NodeJS.Platform;
  smallFs: string | undefined;
  uid: number | undefined;
  stat(directory: string): { isDirectory: boolean; uid: number };
  statfs(directory: string): { blocks: number; bsize: number };
};

export const nodeInjectionHostPorts = (): InjectionHostPorts => ({
  platform: process.platform,
  smallFs: process.env[SMALL_FS_ENV],
  uid: process.getuid?.(),
  stat: (directory) => {
    const stat = fs.statSync(directory);
    return { isDirectory: stat.isDirectory(), uid: stat.uid };
  },
  statfs: (directory) => fs.statfsSync(directory),
});

const NEEDS = `the Linux container, where ${SMALL_FS_ENV} names a directory this process owns on a filesystem of at most ${SMALL_FILESYSTEM_MAX_BYTES} bytes`;

const notContainer = (why: string): InjectionHost => ({ linuxContainer: false, reason: `needs ${NEEDS}; ${why}` });

export const detectInjectionHost = (ports: InjectionHostPorts = nodeInjectionHostPorts()): InjectionHost => {
  if (ports.platform !== 'linux') return notContainer(`this host is ${ports.platform}`);
  const directory = ports.smallFs;
  if (directory === undefined || directory === '') return notContainer(`${SMALL_FS_ENV} is not set`);
  const stat = ports.stat(directory);
  if (!stat.isDirectory) return notContainer(`${SMALL_FS_ENV}=${directory} is not a directory`);
  if (stat.uid !== ports.uid) return notContainer(`${SMALL_FS_ENV}=${directory} is owned by uid ${stat.uid}, not by uid ${String(ports.uid)}`);
  const { blocks, bsize } = ports.statfs(directory);
  if (blocks * bsize > SMALL_FILESYSTEM_MAX_BYTES) return notContainer(`the filesystem of ${SMALL_FS_ENV}=${directory} holds ${blocks * bsize} bytes`);
  return { linuxContainer: true, smallFsBase: directory };
};
