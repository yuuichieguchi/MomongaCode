import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { ExecFn } from './fm-serve.ts';

const OS_BUILD_COMMAND = '/usr/bin/sw_vers';

export const sha256OfFile = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await fs.promises.readFile(file))
    .digest('hex');

export const readOsBuild = async (exec: ExecFn, signal?: AbortSignal): Promise<string> => {
  const result = await exec(OS_BUILD_COMMAND, ['-buildVersion'], ...(signal === undefined ? [] : [{ signal }]));
  if (result.exitCode !== 0) throw new Error(`sw_vers -buildVersion exited with ${result.exitCode}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

type CachedKey = { identity: string; binarySha256: string; osBuild: string };

export const createFmKeyCache = (binary: string, exec: ExecFn, boundMs: number) => {
  let cached: Promise<CachedKey> | undefined;
  let cachedIdentity: string | undefined;
  const compute = async (identity: string): Promise<CachedKey> => ({
    identity,
    binarySha256: await sha256OfFile(binary),
    osBuild: await readOsBuild(exec, AbortSignal.timeout(boundMs)),
  });
  return {
    read: async (target: string): Promise<{ target: string; binarySha256: string; osBuild: string }> => {
      const stat = await fs.promises.stat(binary);
      const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (cached === undefined || cachedIdentity !== identity) {
        cachedIdentity = identity;
        cached = compute(identity);
        cached.catch(() => {
          if (cachedIdentity === identity) {
            cached = undefined;
            cachedIdentity = undefined;
          }
        });
      }
      const key = await cached;
      return { target, binarySha256: key.binarySha256, osBuild: key.osBuild };
    },
  };
};
