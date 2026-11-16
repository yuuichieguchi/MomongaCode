import { describe, expect, it } from 'vitest';
import { isPinnedRuleVerdict } from '@momonga/protocol';
import { titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { shutdownBarrier, startStack } from './support/stack.ts';
import { textReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const ALLOW_RULES = { permissions: { allow: ['Bash(git status)', 'Read(./src/**)'] } };

describe('momonga policy verify and a run of the same folder decide the same rule set (P-420)', () => {
  it(titleOf('policy-fingerprint'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, settings: ALLOW_RULES, script: [textReply('verified')] });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession();
      const { run } = await runtime.createRun(session.id, 'Say something');
      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} is COMPLETED` });
      const [started] = readDb<{ payload_json: string }>(home.paths.databases.runtime, "SELECT payload_json FROM events WHERE run_id = ? AND type = 'run.started'", run.id);
      const pinned: unknown = (JSON.parse(started?.payload_json ?? 'null') as { pins?: { policyVerdict?: unknown } }).pins?.policyVerdict;
      if (!isPinnedRuleVerdict(pinned)) throw new Error(`the run pinned no rule verdict: ${JSON.stringify(pinned)}`);

      const verified = await runtime.json('POST', '/v1/policy/verify', { project: home.project, secrets: [], mode: session.permissionMode });

      expect(verified.status).toBe(200);
      expect(verified.body).toMatchObject({ fingerprint: pinned.fingerprint });
    } finally {
      await runtime.close();
    }
    await shutdownBarrier(stack);
  });
});
