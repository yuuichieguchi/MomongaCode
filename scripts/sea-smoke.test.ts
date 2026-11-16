import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseTargetOf } from '@momonga/foundation';
import { modelSettings, startFakeChatCompletions } from '@momonga/testkit';
import cliPackage from '../packages/cli/package.json' with { type: 'json' };
import { runCli } from '../e2e/support/cli.ts';
import { createE2eHome, registerE2eCleanup } from '../e2e/support/home.ts';
import { spawnPty } from '../e2e/support/pty.ts';
import { chatCompletions, textReply } from '../e2e/support/upstream.ts';
import { defaultEntry } from './bundle.ts';
import { buildSea, hostSeaTarget } from './sea.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const FINAL_TEXT = 'Smoke test answered.';

const SEA_SMOKE_EXECUTABLE_VARIABLE = 'MOMONGA_SEA_SMOKE_EXECUTABLE';

const GIVEN_EXECUTABLE = process.env[SEA_SMOKE_EXECUTABLE_VARIABLE];

const HOST_HAS_SEA_TARGET = releaseTargetOf(process.platform, process.arch) !== undefined;

describe.runIf(HAS_POSIX_SHELL && HOST_HAS_SEA_TARGET)('the single executable built for this platform starts on it', () => {
  let root = '';
  let binary = '';

  beforeAll(async () => {
    root = createTempRoot();
    if (GIVEN_EXECUTABLE !== undefined) {
      binary = path.resolve(GIVEN_EXECUTABLE);
      return;
    }
    binary = path.join(root, 'momonga');
    await buildSea({ entry: defaultEntry, output: binary, workDir: path.join(root, 'work'), target: hostSeaTarget() });
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('prints its version', async () => {
    const home = await createE2eHome();

    expect(await runCli(home, ['--version'], { executable: binary })).toMatchObject({ code: 0, stdout: `${cliPackage.version}\n`, stderr: '' });
  });

  it('runs a task through a daemon it starts from the same executable', async () => {
    const home = await createE2eHome();
    const upstream = await startFakeChatCompletions({ scenario: 'tools-ok', maxConcurrency: 8, socketPath: home.upstreamSocket, script: [textReply(FINAL_TEXT)] });
    registerE2eCleanup(() => upstream.close());
    fs.mkdirSync(path.dirname(home.paths.settingsFile), { recursive: true });
    fs.writeFileSync(
      home.paths.settingsFile,
      JSON.stringify({
        ...modelSettings({ start: 'fake/system', models: [{ provider: 'fake', id: 'system', socketPath: home.upstreamSocket, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }),
        sandbox: 'none',
      }),
    );
    try {
      const result = await runCli(home, ['-p', 'Answer the smoke test'], { executable: binary });

      expect(result).toMatchObject({ code: 0, stdout: `${FINAL_TEXT}\n` });
      expect(chatCompletions(upstream)).toHaveLength(1);
    } finally {
      expect(await runCli(home, ['daemon', 'stop'], { executable: binary })).toMatchObject({ code: 0 });
    }
  });

  it('draws the first frame of the terminal UI', async () => {
    const home = await createE2eHome();

    const pty = await spawnPty(home, [], {}, { executable: binary });

    await pty.waitFor('Do you trust the files in');
  });
});
