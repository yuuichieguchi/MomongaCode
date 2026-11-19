import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir, pollUntil, waitForFile } from '@momonga/testkit';
import { spawn, spawnSync } from '@momonga/testkit/child-process';
import { repoRoot } from '../scripts/bundle.ts';
import { createTempRoot, removeTempRoot } from '../scripts/support/temp.ts';

const BOUNDED = path.join(repoRoot, 'scripts/site/bounded.ts');
const SHORT_BOUND_SECONDS = '0.4';
const WAIT_MS = 4_000;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const hangingCommand = (root: string): { script: string; childFile: string; grandchildFile: string } => {
  const dir = createTempDir({ parent: root });
  const script = path.join(dir, 'hang.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho $$ > "$1.tmp" && mv "$1.tmp" "$1"\nsleep 30 &\necho $! > "$2.tmp" && mv "$2.tmp" "$2"\nwait\n', { mode: 0o755 });
  return { script, childFile: path.join(dir, 'child.pid'), grandchildFile: path.join(dir, 'grandchild.pid') };
};

const pidIn = async (file: string): Promise<number> => Number((await waitForFile(file, { description: file, boundMs: WAIT_MS })).trim());

const expectGone = async (pids: readonly number[]): Promise<void> => {
  await pollUntil(() => pids.every((pid) => !isAlive(pid)), { description: `processes ${pids.join(', ')} gone`, boundMs: WAIT_MS });
};

describe('scripts/site/bounded.ts', () => {
  let root = '';

  beforeAll(() => {
    root = createTempRoot();
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('stops the command and every process it started when the bound passes, and fails', async () => {
    const { script, childFile, grandchildFile } = hangingCommand(root);
    const result = spawnSync(process.execPath, [BOUNDED, SHORT_BOUND_SECONDS, '/bin/sh', script, childFile, grandchildFile], { encoding: 'utf8', timeout: WAIT_MS });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`site-deploy.sh: /bin/sh did not finish within ${SHORT_BOUND_SECONDS} seconds and was stopped`);
    await expectGone([await pidIn(childFile), await pidIn(grandchildFile)]);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stops the command and every process it started when it receives %s', async (signal) => {
    const { script, childFile, grandchildFile } = hangingCommand(root);
    const wrapper = spawn(process.execPath, [BOUNDED, '30', '/bin/sh', script, childFile, grandchildFile], { stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => wrapper.on('exit', (code) => resolve(code)));
    const pids = [await pidIn(childFile), await pidIn(grandchildFile)];
    wrapper.kill(signal);
    expect(await exited).not.toBe(0);
    await expectGone(pids);
  });

  it('ends with the exit status of the command', () => {
    const result = spawnSync(process.execPath, [BOUNDED, '30', '/bin/sh', '-c', 'exit 7'], { encoding: 'utf8', timeout: WAIT_MS });
    expect(result.status, result.stderr).toBe(7);
  });

  it('fails when the command is ended by a signal', () => {
    const result = spawnSync(process.execPath, [BOUNDED, '30', '/bin/sh', '-c', 'kill -TERM $$'], { encoding: 'utf8', timeout: WAIT_MS });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('site-deploy.sh: /bin/sh was stopped by SIGTERM');
  });
});
