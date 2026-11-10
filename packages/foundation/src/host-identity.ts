import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { settledOrAborted } from './operation-limit.ts';
import { startSharedCall } from './shared-call.ts';
import type { SharedCall } from './shared-call.ts';

export type ProbeKeyReading = { kind: 'read'; value: string } | { kind: 'unreadable'; reason: string };

export type ProbeKeyReadings = Record<string, ProbeKeyReading>;

export type HostExecAnswer = { exitCode: number; stdout: string; stderr: string };

export type HostExec = (file: string, args: readonly string[], options: { signal: AbortSignal }) => Promise<HostExecAnswer>;

export const createHostExec =
  (env?: Readonly<Record<string, string>>): HostExec =>
  (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(file, [...args], { ...(env === undefined ? {} : { env: { ...env } }), signal: options.signal }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(error);
      });
    });

export type BinaryHashCache = { sha256Of(file: string, signal: AbortSignal): Promise<string> };

export const PROBE_KEY_COMPONENT_LABELS: Readonly<Record<string, string>> = {
  binarySha256: 'binary sha256',
  hostOsBuild: 'OS build',
};

export const probeKeyComponentLabel = (component: string): string => {
  const label = PROBE_KEY_COMPONENT_LABELS[component];
  if (label === undefined) throw new Error(`the probe key component ${component} has no reader`);
  return label;
};

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const streamedSha256 = async (file: string, signal: AbortSignal): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash, { signal });
  return hash.digest('hex');
};

const fileIdentityOf = (stat: fs.Stats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;

const NO_LIFETIME_END = new AbortController().signal;

export const createBinaryHashCache = (): BinaryHashCache => {
  const cached = new Map<string, { identity: string; call: SharedCall<string> }>();
  return {
    sha256Of: async (file, signal) => {
      const identity = fileIdentityOf(await fs.promises.stat(file));
      const known = cached.get(file);
      if (known !== undefined && known.identity === identity) return known.call.join(signal);
      const forget = (): void => {
        if (cached.get(file)?.call === call) cached.delete(file);
      };
      const call = startSharedCall(NO_LIFETIME_END, (shared) => streamedSha256(file, shared), forget);
      cached.set(file, { identity, call });
      call.work.catch(forget);
      return call.join(signal);
    },
  };
};

export type HeldHostReadings = {
  held(component: string, signal: AbortSignal, read: (shared: AbortSignal) => Promise<ProbeKeyReading>): Promise<ProbeKeyReading>;
  release(): void;
};

export const createHeldHostReadings = (): HeldHostReadings => {
  const readings = new Map<string, SharedCall<ProbeKeyReading>>();
  return {
    held: (component, signal, read) => {
      const known = readings.get(component);
      if (known !== undefined) return known.join(signal);
      const forget = (): void => {
        if (readings.get(component) === call) readings.delete(component);
      };
      const call = startSharedCall(NO_LIFETIME_END, read, forget);
      readings.set(component, call);
      call.work.then((result) => {
        if (result.kind === 'unreadable') forget();
      }, forget);
      return call.join(signal);
    },
    release: () => readings.clear(),
  };
};

const UNHELD: HeldHostReadings = { held: (_component, signal, read) => settledOrAborted(read(signal), signal), release: () => undefined };

const UNCACHED: BinaryHashCache = { sha256Of: (file, signal) => streamedSha256(file, signal) };

type ComponentRequest = { binary: string; platform: NodeJS.Platform; exec: HostExec; signal: AbortSignal; hashes: BinaryHashCache; host: HeldHostReadings };

type ComponentReader = (request: ComponentRequest) => Promise<ProbeKeyReading>;

type OsBuildReader = (request: Pick<ComponentRequest, 'exec' | 'signal'>) => Promise<ProbeKeyReading>;

const swVersBuild: OsBuildReader = async ({ exec, signal }) => {
  let answer: HostExecAnswer;
  try {
    answer = await exec('sw_vers', ['-buildVersion'], { signal });
  } catch (error) {
    signal.throwIfAborted();
    return { kind: 'unreadable', reason: `sw_vers -buildVersion could not be run: ${reasonOf(error)}` };
  }
  if (answer.exitCode !== 0) return { kind: 'unreadable', reason: `sw_vers -buildVersion exited with ${answer.exitCode}: ${answer.stderr.trim()}` };
  const build = answer.stdout.trim();
  return build === '' ? { kind: 'unreadable', reason: 'sw_vers -buildVersion printed nothing' } : { kind: 'read', value: build };
};

const OS_BUILD_READERS: Partial<Record<NodeJS.Platform, OsBuildReader>> = { darwin: swVersBuild };

const COMPONENT_READERS: Readonly<Record<string, ComponentReader>> = {
  binarySha256: async ({ binary, signal, hashes }) => {
    try {
      return { kind: 'read', value: await hashes.sha256Of(binary, signal) };
    } catch (error) {
      signal.throwIfAborted();
      return { kind: 'unreadable', reason: `the executable ${binary} cannot be read: ${reasonOf(error)}` };
    }
  },
  hostOsBuild: async ({ platform, exec, signal, host }) => {
    const reader = OS_BUILD_READERS[platform];
    if (reader === undefined) return { kind: 'unreadable', reason: `no OS build reader exists on ${platform}` };
    return host.held('hostOsBuild', signal, (shared) => reader({ exec, signal: shared }));
  },
};

export type ReadProbeKeyComponentsRequest = {
  identity: readonly string[];
  binary: string;
  platform: NodeJS.Platform;
  exec: HostExec;
  signal: AbortSignal;
  hashes?: BinaryHashCache;
  host?: HeldHostReadings;
};

export const readProbeKeyComponents = async (request: ReadProbeKeyComponentsRequest): Promise<ProbeKeyReadings> => {
  const hashes = request.hashes ?? UNCACHED;
  const host = request.host ?? UNHELD;
  const readings: ProbeKeyReadings = {};
  for (const component of request.identity) {
    const reader = COMPONENT_READERS[component];
    if (reader === undefined) throw new Error(`the probe key component ${component} has no reader`);
    readings[component] = await reader({ binary: request.binary, platform: request.platform, exec: request.exec, signal: request.signal, hashes, host });
  }
  return readings;
};
