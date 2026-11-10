import { execFile, spawn } from '@momonga/testkit/child-process';
import type { StdioOptions } from '@momonga/testkit/child-process';
import os from 'node:os';

const PROBE = 'for fd in 3 4; do if (: <&$fd) 2>/dev/null; then echo fd$fd; fi; done';

const viaExecFile = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', PROBE], (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
  });

const viaSpawn = (stdio: StdioOptions | undefined, extra: { detached?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', PROBE], { ...(stdio === undefined ? {} : { stdio }), ...extra });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', () => resolve(output));
  });

const viaInherit = async (): Promise<string> => {
  process.stdout.write('<<inherit\n');
  await viaSpawn('inherit');
  process.stdout.write('>>inherit\n');
  return '';
};

const results: Record<string, string> = {};
results['execFile'] = await viaExecFile();
results['spawn'] = await viaSpawn(undefined);
results['spawnDetached'] = await viaSpawn(undefined, { detached: true, cwd: os.tmpdir(), env: { PATH: '/usr/bin:/bin' } });
results['explicit'] = await viaSpawn(['ignore', 'pipe', 'pipe', 3, 4]);
await viaInherit();
process.stdout.write(`${JSON.stringify(results)}\n`);
