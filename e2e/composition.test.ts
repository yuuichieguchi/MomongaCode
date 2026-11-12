import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultSandboxSetting } from '@momonga/config';
import { CLI_BUNDLE } from './support/cli-bundles.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import { processCommandOf } from './support/ledger.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { shutdownBarrier, startStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const PRODUCT_DEFAULT_MODE = 'manual';

const commandOf = async (pid: number | undefined): Promise<string> => {
  if (pid === undefined) throw new Error('the child has no pid');
  const command = await processCommandOf(pid);
  if (command === undefined) throw new Error(`process ${pid} is gone`);
  return command;
};

describe('the e2e stack is the product composition', () => {
  it('starts the daemons from the built bundle with the product defaults, and a session without a stated mode runs in the product default mode', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, script: [textReply('composed')] });

    expect(await commandOf(stack.supervisor.pid)).toContain(`${CLI_BUNDLE} __supervise`);
    expect(await commandOf(childOf(stack.health, 'gateway').pid)).toContain(`${CLI_BUNDLE} __gateway`);
    expect(await commandOf(childOf(stack.health, 'runtime').pid)).toContain(`${CLI_BUNDLE} __runtime`);

    const settings: unknown = JSON.parse(fs.readFileSync(home.paths.settingsFile, 'utf8'));
    expect(settings).not.toHaveProperty('runtime');
    expect(settings).toHaveProperty('sandbox', defaultSandboxSetting());

    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Say something');
      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} is COMPLETED` });
      const [started] = readDb<{ payload_json: string }>(home.paths.databases.runtime, "SELECT payload_json FROM events WHERE run_id = ? AND type = 'run.started'", run.id);
      expect(JSON.parse(started?.payload_json ?? 'null')).toMatchObject({ mode: PRODUCT_DEFAULT_MODE });
    } finally {
      await runtime.close();
    }
    await shutdownBarrier(stack);
  });
});
