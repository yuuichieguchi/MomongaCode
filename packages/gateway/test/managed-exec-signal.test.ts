import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createExecFn } from '../src/managed/processes.ts';
import { registerCleanup } from './gateway-helpers.ts';
import { isAlive, makeHome, until } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('createExecFn honours the abort signal', () => {
  it(
    'kills a hung command when the signal aborts and settles the call',
    async () => {
      const dir = makeHome();
      const pidFile = path.join(dir, 'hung.pid');
      const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30);`;
      const controller = new AbortController();
      const running = createExecFn(undefined)(process.execPath, ['-e', script], { signal: controller.signal });
      let outcome: string | undefined;
      void running.then(
        () => {
          outcome = 'resolved';
        },
        (error: unknown) => {
          outcome = error instanceof Error ? error.name : 'unknown';
        },
      );
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', 'the hung command wrote its pid');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      registerCleanup(() => {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      });
      controller.abort();
      await until(() => outcome !== undefined, 'the aborted call settled');
      expect(outcome).toBe('AbortError');
      await until(() => !isAlive(pid), 'the hung command exited');
    },
  );
});
