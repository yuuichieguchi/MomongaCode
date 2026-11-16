import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { createE2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { shutdownBarrier, startStack } from './support/stack.ts';
import { textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const STORED_REPLY = 'the reply the gateway keeps';
const CAPTURING = { telemetry: { captureMessageContent: true } };

describe('the gateway content route against a daemon (P-394)', () => {
  it(titleOf('trace-content'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, settings: CAPTURING, script: [textReply(STORED_REPLY)] });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Say something');
      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} is COMPLETED` });

      const shown = await runCli(home, ['trace', run.id, '--content', '--json']);

      expect(shown.code).toBe(0);
      const bodies = shown.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { store: string; content: string });
      expect(bodies.filter((body) => body.store === 'gateway' && body.content.includes(STORED_REPLY)).length).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
    await shutdownBarrier(stack);
  });
});
