import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

export const codeDigestOfRunningCli = async (): Promise<string> => {
  const file = isSea() ? process.execPath : fileURLToPath(import.meta.url);
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
};
