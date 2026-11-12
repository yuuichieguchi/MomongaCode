import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import { startStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { chatCompletions, textReply } from './support/upstream.ts';
import { E2E_RECOVERY_BOUND_MS, E2E_RESTART_BOUND_MS, E2E_RESTART_POLICY, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const REPLY_AFTER_RESTART = 'after the restart';

describe('b3: kill the gateway during the model call', () => {
  it(titleOf('b3-gateway-kill'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({
      home,
      deps: { restart: E2E_RESTART_POLICY },
      script: [textReply(REPLY_AFTER_RESTART)],
    });
    const runtime = createRuntimeClient(home);
    const hold = stack.fake.hold();
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Say hello');
      await hold.waitForRequest();
      const disconnectsBefore = stack.fake.disconnects();

      const before = await stack.client.health();
      const oldGateway = childOf(before, 'gateway');
      const oldRuntime = childOf(before, 'runtime');
      expect(oldGateway.restarts).toBe(0);
      const oldGatewayPid = oldGateway.pid;
      if (oldGatewayPid === undefined) throw new Error('gateway has no pid');

      process.kill(oldGatewayPid, 'SIGKILL');

      const newGateway = await stack.client.untilChild(
        'gateway',
        (child) => child.state === 'ready' && child.pid !== undefined && child.pid !== oldGatewayPid && child.restarts === 1,
        E2E_RESTART_BOUND_MS,
      );
      const afterRestart = await stack.client.health();
      const runtimeAfterRestart = childOf(afterRestart, 'runtime');
      expect(runtimeAfterRestart.pid).toBe(oldRuntime.pid);
      expect(runtimeAfterRestart.restarts).toBe(0);

      await until(() => stack.fake.disconnects() > disconnectsBefore, {
        deadlineMs: E2E_RESTART_BOUND_MS,
        description: 'the dead gateway dropped the held upstream connection',
      });

      const stream = runtime.events(run.id);
      const frames = await stream.toEnd(E2E_RECOVERY_BOUND_MS);
      await stream.close();

      const last = frames.at(-1);
      expect(last?.data.type).toBe('run.status');
      expect(last?.data.to).toBe('COMPLETED');
      expect(framesOfType(frames, 'model.responded')).toHaveLength(1);
      expect(framesOfType(frames, 'agent.message.delta').map((frame) => frame.data.text).join('')).toBe(REPLY_AFTER_RESTART);

      const calls = chatCompletions(stack.fake).length;
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(calls).toBeLessThanOrEqual(2);

      const final = await runtime.getRun(run.id);
      expect(final.run.status).toBe('COMPLETED');
      expect(final.run.step).toBe(1);

      const end = await stack.client.health();
      expect(childOf(end, 'gateway').pid).toBe(newGateway.pid);
      expect(childOf(end, 'gateway').restarts).toBe(1);
      expect(childOf(end, 'runtime').pid).toBe(oldRuntime.pid);
      expect(childOf(end, 'runtime').restarts).toBe(0);
    } finally {
      hold.release();
      await runtime.close();
    }
  });
});
