import net from 'node:net';
import path from 'node:path';
import { createAsyncCapabilityProbe } from './capability-probe.ts';
import type { CapabilityResult } from './capability-probe.ts';
import { nodeFileSystemSync } from './node-file-system.ts';
import { systemRandom } from './system-random.ts';

export const PIPE_NAME_LIMIT = 256;

const PIPE_PREFIX = '\\\\.\\pipe\\';
const PIPE_PATH = /^\\\\[.?]\\pipe\\/;

export const isPipePath = (candidate: string): boolean => PIPE_PATH.test(candidate);

export type EndpointForm = 'unix' | 'pipe';

const ENDPOINT_FORMS_OF_PATH_FLAVOUR: Readonly<Record<'filesystem' | 'pipe', readonly EndpointForm[]>> = { filesystem: ['unix'], pipe: ['pipe'] };

export const endpointFormsOfSocket = (hostSocketPath: string): readonly EndpointForm[] => ENDPOINT_FORMS_OF_PATH_FLAVOUR[isPipePath(hostSocketPath) ? 'pipe' : 'filesystem'];

export type EndpointHost = { readonly platform: string; readonly forms: readonly EndpointForm[] };

export const endpointHostOf = (platform: NodeJS.Platform = process.platform): EndpointHost => ({ platform, forms: ENDPOINT_FORMS_OF_PATH_FLAVOUR[platform === 'win32' ? 'pipe' : 'filesystem'] });

export type EndpointScope = { readonly form: 'unix' } | { readonly form: 'pipe'; readonly token: string };

const ENDPOINT_TOKEN_TEXT = /^[0-9a-f]{32}$/;

export class EndpointScopeMissingError extends Error {}

const PRODUCT_PIPE_PREFIX = `${PIPE_PREFIX}momonga-`;

const SCOPED_PIPE = /^\\\\[.?]\\pipe\\momonga-[0-9a-f]{32}-/;

const missingPart = (name: string): EndpointScopeMissingError =>
  new EndpointScopeMissingError(`the named pipe ${name} needs the random part of this home (its token file in run/), so it is not served or dialled`);

export const pipePathFor = (scope: EndpointScope | undefined, name: string): string => {
  if (scope?.form !== 'pipe' || !ENDPOINT_TOKEN_TEXT.test(scope.token)) throw missingPart(name);
  return `${PRODUCT_PIPE_PREFIX}${scope.token}-${name}`;
};

export const assertScopedPipePath = (pipePath: string): void => {
  if (!SCOPED_PIPE.test(pipePath)) throw missingPart(pipePath);
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
  const name = systemRandom.hex(Math.ceil(nameLength / 2)).slice(0, nameLength);
  return path.join(directory, name);
};

export type SocketBindRefusal =
  | { kind: 'unsupported'; byteLength: number; directory: string; code: string }
  | { kind: 'unmeasured'; byteLength: number; directory: string; reason: string };

const bindRefusalOf = async (bind: SocketBind, socketPath: string): Promise<SocketBindRefusal | undefined> => {
  const directory = path.dirname(socketPath);
  const byteLength = Buffer.byteLength(socketPath);
  try {
    await bind(probePathOfLength(directory, byteLength));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && PATH_TOO_LONG_ERRNO.has(code)) return { kind: 'unsupported', byteLength, directory, code };
    return { kind: 'unmeasured', byteLength, directory, reason: code ?? (error as Error).message };
  }
  return undefined;
};

export const createSocketPathProbe = (bind: SocketBind): ((socketPath: string) => Promise<CapabilityResult<number>>) =>
  createAsyncCapabilityProbe<string, number>(
    (socketPath) => `${Buffer.byteLength(socketPath)}:${path.dirname(socketPath)}`,
    async (socketPath) => {
      const refusal = await bindRefusalOf(bind, socketPath);
      if (refusal === undefined) {
        const byteLength = Buffer.byteLength(socketPath);
        return { kind: 'supported', value: byteLength, evidence: `the kernel bound a Unix socket path of ${byteLength} bytes in ${path.dirname(socketPath)}` };
      }
      const { byteLength, directory } = refusal;
      if (refusal.kind === 'unsupported') {
        return {
          kind: 'unsupported',
          evidence: `the kernel refused to bind a Unix socket path of ${byteLength} bytes in ${directory} (${refusal.code}); the path must be shorter than ${byteLength} bytes. Use a shorter path.`,
        };
      }
      return { kind: 'unmeasured', evidence: `a socket path of ${byteLength} bytes could not be tested in ${directory}: ${refusal.reason}` };
    },
  );

const bindThenClose: SocketBind = (socketPath) =>
  new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.close((closeError) => {
        nodeFileSystemSync.rmSync(socketPath);
        if (closeError === undefined) resolve();
        else reject(closeError);
      });
    });
  });

let hostBind: SocketBind = bindThenClose;

let socketPathProbe = createSocketPathProbe(hostBind);

export const setSocketBind = (bind: SocketBind | undefined): void => {
  hostBind = bind ?? bindThenClose;
  socketPathProbe = createSocketPathProbe(hostBind);
};

export const socketBindRefusalOf = (socketPath: string): Promise<SocketBindRefusal | undefined> => bindRefusalOf(hostBind, socketPath);

export class SocketPathUnsupportedError extends Error {}

export class SocketPathUnmeasuredError extends Error {}

export const assertUnixSocketPathFits = async (socketPath: string): Promise<void> => {
  const result = await socketPathProbe(socketPath);
  if (result.kind === 'supported') return;
  const message = `Unix socket path ${socketPath}: ${result.evidence}`;
  throw result.kind === 'unsupported' ? new SocketPathUnsupportedError(message) : new SocketPathUnmeasuredError(message);
};
