import fs from 'node:fs';
import { kernelLockNamed } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { nodeUpdateFs } from '../src/update/node-ports.ts';

const [mechanism, target, staged] = process.argv.slice(2) as [KernelLockMechanism['name'], string, string];

const runningImageRename = async (from: string, to: string): Promise<void> => {
  if (to === target && fs.existsSync(target)) throw Object.assign(new Error('EBUSY: rename refused'), { code: 'EBUSY' });
  await fs.promises.rename(from, to);
};

await nodeUpdateFs(kernelLockNamed(mechanism), runningImageRename).publish(staged, target);
process.stdout.write('published\n');
process.stdin.resume();
process.stdin.once('end', () => process.exit(0));
