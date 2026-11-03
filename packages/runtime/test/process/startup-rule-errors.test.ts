import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ConfigError } from '@momonga/config';
import { writeUserSettings } from './helpers.ts';
import { RUNTIME_VERSION, captureStream, hookLogger, makeRunHome, startRuntimeProcess } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

const failureOrClose = async (started: ReturnType<typeof startRuntimeProcess>): Promise<unknown> =>
  started.then(
    async (runtimeProcess) => {
      await runtimeProcess.close();
      throw new Error('expected startup to fail');
    },
    (error: unknown) => error,
  );

describe('startup with an unusable path rule in user settings (system timers)', () => {
  it('stops with a ConfigError naming the settings file for Read(a[b)', PROCESS_TIMEOUT, async () => {
    const temp = makeRunHome();
    fs.mkdirSync(temp.paths.root, { recursive: true, mode: 0o700 });
    writeUserSettings(temp.home, { sandbox: 'none', permissions: { deny: ['Read(a[b)'] } });
    const started = startRuntimeProcess({ home: temp.home, version: RUNTIME_VERSION, logger: hookLogger(() => undefined), stdout: captureStream() });
    const error = await failureOrClose(started);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(temp.paths.settingsFile);
    expect((error as Error).message).toContain('Read(a[b)');
  });
});
