import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createAsyncCapabilityProbe } from './capability-probe.ts';
import type { CapabilityResult } from './capability-probe.ts';

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

export const assertSocketPathLength = (socketPath: string): void => {
  if (isPipePath(socketPath) && socketPath.length > PIPE_NAME_LIMIT) {
    throw new Error(`Named pipe ${socketPath} is ${socketPath.length} characters; it must be at most ${PIPE_NAME_LIMIT} characters. Use a shorter name.`);
  }
};

export type SocketBind = (socketPath: string) => Promise<void>;

const PATH_TOO_LONG_ERRNO = new Set(['ENAMETOOLONG', 'EINVAL']);

const probePathOfLength = (directory: string, byteLength: number): string => {
  const prefix = path.join(directory, 'x');
  const nameLength = byteLength - Buffer.byteLength(prefix) + 1;
  const name = randomBytes(Math.ceil(nameLength / 2)).toString('hex').slice(0, nameLength);
  return path.join(directory, name);
};

export const createSocketPathProbe = (bind: SocketBind): ((socketPath: string) => Promise<CapabilityResult<number>>) =>
  createAsyncCapabilityProbe<string, number>(
    (socketPath) => `${Buffer.byteLength(socketPath)}:${path.dirname(socketPath)}`,
    async (socketPath) => {
      const directory = path.dirname(socketPath);
      const byteLength = Buffer.byteLength(socketPath);
      try {
        await bind(probePathOfLength(directory, byteLength));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && PATH_TOO_LONG_ERRNO.has(code)) {
          return {
            kind: 'unsupported',
            evidence: `the kernel refused to bind a Unix socket path of ${byteLength} bytes in ${directory} (${code}); the path must be shorter than ${byteLength} bytes. Use a shorter path.`,
          };
        }
        return { kind: 'unmeasured', evidence: `a Unix socket path of ${byteLength} bytes in ${directory} could not be tested: ${code ?? (error as Error).message}` };
      }
      return { kind: 'supported', value: byteLength, evidence: `the kernel bound a Unix socket path of ${byteLength} bytes in ${directory}` };
    },
  );

const bindThenClose: SocketBind = (socketPath) =>
  new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.close((closeError) => {
        fs.rmSync(socketPath, { force: true });
        if (closeError === undefined) resolve();
        else reject(closeError);
      });
    });
  });

let socketPathProbe = createSocketPathProbe(bindThenClose);

export const setSocketBind = (bind: SocketBind | undefined): void => {
  socketPathProbe = createSocketPathProbe(bind ?? bindThenClose);
};

export class SocketPathUnsupportedError extends Error {}

const measureUnixSocketPath = async (socketPath: string): Promise<CapabilityResult<number>> => {
  const result = await socketPathProbe(socketPath);
  if (result.kind === 'unsupported') throw new SocketPathUnsupportedError(`Unix socket path ${socketPath}: ${result.evidence}`);
  return result;
};

export const refuseUnbindableUnixSocketPath = async (socketPath: string): Promise<void> => {
  await measureUnixSocketPath(socketPath);
};

export const assertUnixSocketPathFits = async (socketPath: string): Promise<void> => {
  const result = await measureUnixSocketPath(socketPath);
  if (result.kind === 'unmeasured') throw new Error(`Unix socket path ${socketPath}: ${result.evidence}`);
};
