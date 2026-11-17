import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawn } from '@momonga/testkit/child-process';
import { createTempDir } from '../../packages/testkit/src/test-support.ts';
import { systemWaitTiming, waitUntil } from '@momonga/foundation';

const RUNNER_URL = pathToFileURL(path.resolve(import.meta.dirname, 'runner.ts')).href;
const RUNNER_CODE = 'const { runTlc } = await import(process.env.RUNNER_URL); await runTlc(JSON.parse(process.env.TLC_OPTIONS));';
const WAIT_MS = 30_000;

const groupGone = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

const waitFor = <T>(probe: () => T | undefined): Promise<T | undefined> =>
  waitUntil(systemWaitTiming, async () => probe(), { intervalMs: 25, deadline: systemWaitTiming.monotonicMs() + WAIT_MS }).then((outcome) =>
    outcome.kind === 'found' ? outcome.value : undefined,
  );

describe('the TLC runner on a signal', () => {
  it('kills its child group and removes its metadir when it receives SIGTERM', async () => {
    const dir = createTempDir();
    const pidFile = path.join(dir, 'pid');
    const metadirFile = path.join(dir, 'metadir');
    const script = path.join(dir, 'fake-tlc.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho $$ > "${pidFile}"\necho "$TLC_METADIR" > "${metadirFile}"\nsleep 600\n`, { mode: 0o755 });
    const runner = spawn(process.execPath, ['--input-type=module', '-e', RUNNER_CODE], {
      env: { ...process.env, RUNNER_URL, TLC_OPTIONS: JSON.stringify({ script, config: 'fake.cfg', args: [], budgetCpuSeconds: 1_000_000 }) },
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => runner.once('exit', () => resolve()));
    try {
      const pgid = await waitFor(() => (fs.existsSync(metadirFile) && fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined));
      const metadir = await waitFor(() => (fs.existsSync(metadirFile) ? fs.readFileSync(metadirFile, 'utf8').trim() : undefined));
      expect(pgid, 'the fake TLC started').toBeGreaterThan(1);
      runner.kill('SIGTERM');
      await exited;
      expect(await waitFor(() => (groupGone(pgid as number) ? true : undefined)), 'the child group is gone').toBe(true);
      expect(fs.existsSync(metadir as string), 'the metadir is removed').toBe(false);
    } finally {
      runner.kill('SIGKILL');
      const pgid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined;
      if (pgid !== undefined && !groupGone(pgid)) process.kill(-pgid, 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
