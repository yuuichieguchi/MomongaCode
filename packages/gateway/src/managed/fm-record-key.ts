import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { ExecFn } from './fm-serve.ts';

const OS_BUILD_COMMAND = '/usr/bin/sw_vers';

export const sha256OfFile = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await fs.promises.readFile(file))
    .digest('hex');

export const readOsBuild = async (exec: ExecFn): Promise<string> => {
  const result = await exec(OS_BUILD_COMMAND, ['-buildVersion']);
  if (result.exitCode !== 0) throw new Error(`sw_vers -buildVersion exited with ${result.exitCode}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};
