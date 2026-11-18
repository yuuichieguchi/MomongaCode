import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import type { EventsOptions, RunEventFrame, RuntimeClient } from './support/runtime-client.ts';
import { startStack } from './support/stack.ts';
import { textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const PLAN_ARGS = { entries: [{ content: 'inspect the code', status: 'in_progress', priority: 'high' }] };

const SCRIPT = [toolCallReply('UpdatePlan', PLAN_ARGS), textReply('planned')];

const replay = async (runtime: RuntimeClient, runId: string, options: EventsOptions = {}): Promise<RunEventFrame[]> => {
  const stream = runtime.events(runId, options);
  const frames = await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
  await stream.close();
  return frames;
};

const idsOf = (frames: readonly RunEventFrame[]): number[] => frames.map((frame) => frame.id);

const oneThrough = (last: number): number[] => Array.from({ length: last }, (_, index) => index + 1);

describe('e: SSE reconnect', () => {
  it(titleOf('e-replay'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    await startStack({ home, script: SCRIPT });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Plan the work');
      await until(async () => (await runtime.getRun(run.id)).run.status === 'COMPLETED', { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `run ${run.id} COMPLETED` });
      const last = (await runtime.getRun(run.id)).run.lastSeq;

      const full = await replay(runtime, run.id);
      expect(idsOf(full)).toEqual(oneThrough(last));
      expect(full.map((frame) => frame.data.seq)).toEqual(oneThrough(last));
      expect(full.at(-1)?.data).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
      expect(last).toBeGreaterThanOrEqual(6);

      const k = Math.floor(last / 2);
      const expectedTail = full.filter((frame) => frame.id > k);
      expect(idsOf(expectedTail)).toEqual(oneThrough(last).slice(k));

      const byHeader = await replay(runtime, run.id, { lastEventId: k });
      expect(byHeader).toEqual(expectedTail);
      const byQuery = await replay(runtime, run.id, { after: k });
      expect(byQuery).toEqual(byHeader);

      expect(await replay(runtime, run.id, { lastEventId: last })).toEqual([]);

      const pastEndByHeader = await runtime.eventsStatus(run.id, { lastEventId: last + 1 });
      expect(pastEndByHeader.status).toBe(400);
      expect(pastEndByHeader.body).toMatchObject({ error: { param: 'Last-Event-ID' } });
      const pastEndByQuery = await runtime.eventsStatus(run.id, { after: last + 1 });
      expect(pastEndByQuery.status).toBe(400);
      expect(pastEndByQuery.body).toMatchObject({ error: { param: 'after' } });

      expect(await replay(runtime, run.id)).toEqual(full);
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('e-resume'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, script: SCRIPT });
    const runtime = createRuntimeClient(home);
    const hold = stack.fake.hold();
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Plan the work');
      const live = runtime.events(run.id);
      const requested = await live.until((frame) => frame.data.type === 'model.requested', E2E_RUN_COMPLETED_BOUND_MS);
      await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the held model request' });
      await live.close();
      const k = requested.id - 2;
      expect(k).toBeGreaterThanOrEqual(1);
      const beforeDrop = live.frames().filter((frame) => frame.id <= k);
      expect(idsOf(beforeDrop)).toEqual(oneThrough(k));
      expect((await runtime.getRun(run.id)).run.status).toBe('RUNNING');

      const resumedStream = runtime.events(run.id, { lastEventId: k });
      const firstResumed = await resumedStream.until(() => true, E2E_RUN_COMPLETED_BOUND_MS);
      expect(firstResumed.id).toBe(k + 1);
      expect((await runtime.getRun(run.id)).run.status).toBe('RUNNING');
      hold.release();
      const resumed = await resumedStream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await resumedStream.close();
      expect(resumed[0]?.id).toBe(k + 1);

      const full = await replay(runtime, run.id);
      const last = (await runtime.getRun(run.id)).run.lastSeq;
      expect(full.at(-1)?.data).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
      expect(idsOf(full)).toEqual(oneThrough(last));
      expect([...beforeDrop, ...resumed]).toEqual(full);
    } finally {
      hold.release();
      await runtime.close();
    }
  });
});
