import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipCase, titleOf } from './support/cases.ts';
import { createE2eHome, markersOf } from './support/home.ts';
import { expectEndedAtTerminal } from './support/process.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import { sandboxOrSkip } from './support/sandbox.ts';
import { startStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { chatCompletions, textReply } from './support/upstream.ts';
import { E2E_RECOVERY_BOUND_MS, E2E_RESTART_POLICY, E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const linesOf = (file: string): string[] | undefined => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : undefined);

describe('v: a completion check interrupted by a runtime SIGKILL', () => {
  it.skipIf(skipCase('v-kill-during-check'))(titleOf('v-kill-during-check'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const home = await createE2eHome();
    const runs = path.join(home.project, 'check-runs.log');
    const holder = path.join(home.project, 'check-holder.pid');
    const command = `echo $$ >> ${holder}; echo run >> ${runs}; [ "$(wc -l < ${runs} | tr -d ' ')" -gt 1 ] || sleep 60`;
    const stack = await startStack({
      home,
      needsBash: true,
      deps: { restart: E2E_RESTART_POLICY },
      script: [textReply('done')],
    });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Say hello', { mandate: { completion: { conditions: [{ command }] } } });

      await until(() => linesOf(runs)?.length === 1, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the first run of the check has started' });
      const firstHolder = await until(() => Number(linesOf(holder)?.[0]) || undefined, { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the pid of the first check' });
      expect(fs.readdirSync(markersOf(home).tools).length).toBeGreaterThanOrEqual(1);

      const before = await stack.client.health();
      const oldRuntimePid = childOf(before, 'runtime').pid;
      if (oldRuntimePid === undefined) throw new Error('runtime has no pid');
      expect(chatCompletions(stack.fake)).toHaveLength(1);

      process.kill(oldRuntimePid, 'SIGKILL');

      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', {
        deadlineMs: E2E_RUN_COMPLETED_BOUND_MS,
        description: `run ${run.id} COMPLETED after recovery`,
      });

      expect(linesOf(runs)).toEqual(['run', 'run']);
      await expectEndedAtTerminal('COMPLETED', { group: firstHolder, processes: [firstHolder] });
      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
      expect(framesOfType(frames, 'verification.started').map((frame) => frame.data['attempt'])).toEqual([1, 2]);
      expect(framesOfType(frames, 'verification.completed').map((frame) => frame.data['outcome'])).toEqual(['passed']);
      expect(chatCompletions(stack.fake)).toHaveLength(1);
      expect(childOf(await stack.client.health(), 'runtime').restarts).toBe(1);
    } finally {
      await runtime.close();
    }
  });
});
