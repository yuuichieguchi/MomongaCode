import { createHash } from 'node:crypto';

export const SOCKET_PATH_LIMIT = 104;
export const LINUX_SOCKET_PATH_LIMIT = 108;
export const PIPE_NAME_LIMIT = 256;

const PIPE_PREFIX = '\\\\.\\pipe\\';
const PIPE_PATH = /^\\\\[.?]\\pipe\\/;

export const isPipePath = (candidate: string): boolean => PIPE_PATH.test(candidate);

export const socketPathLimit = (platform: NodeJS.Platform): number => (platform === 'linux' ? LINUX_SOCKET_PATH_LIMIT : SOCKET_PATH_LIMIT);

export const pipePathFor = (home: string, name: string): string => {
  const scope = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
  return `${PIPE_PREFIX}momonga-${scope}-${name}`;
};

export const assertSocketPathLength = (socketPath: string, platform: NodeJS.Platform = process.platform): void => {
  const byteLength = Buffer.byteLength(socketPath);
  if (isPipePath(socketPath)) {
    if (socketPath.length > PIPE_NAME_LIMIT) {
      throw new Error(`Named pipe ${socketPath} is ${socketPath.length} characters; it must be at most ${PIPE_NAME_LIMIT} characters. Use a shorter name.`);
    }
    return;
  }
  const limit = socketPathLimit(platform);
  if (byteLength >= limit) {
    throw new Error(`Unix socket path ${socketPath} is ${byteLength} bytes; it must be shorter than ${limit} bytes. Use a shorter path.`);
  }
};
