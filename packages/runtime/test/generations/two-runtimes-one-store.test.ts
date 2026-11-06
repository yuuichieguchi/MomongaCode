import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { clientOf, eventTypes, launchRuntime, readDb, startStack, waitForStatus } from '../process/run-helpers.ts';
import type { RunHome } from '../process/run-helpers.ts';

type GenerationScope = (paths: MomongaPaths, generation: number) => MomongaPaths;

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

const scopeToGeneration = (): GenerationScope => {
  const value = (foundation as Record<string, unknown>)['scopeToGeneration'];
  if (typeof value !== 'function') throw new Error('@momonga/foundation does not export scopeToGeneration');
  return value as GenerationScope;
};

const generationHome = (temp: RunHome, generation: number): RunHome => ({ ...temp, paths: scopeToGeneration()(temp.paths, generation) });

describe('H1: two runtime generations share one store', () => {
  it('starts a second runtime generation beside a running one on the same home and store', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const gatewaySocketPath = stack.temp.paths.sockets.gateway;
    const first = await launchRuntime(stack.temp, { gatewaySocketPath, generation: 1 } as Parameters<typeof launchRuntime>[1]);
    const second = await launchRuntime(stack.temp, { gatewaySocketPath, generation: 2 } as Parameters<typeof launchRuntime>[1]);
    expect(first.handle.ready.socketPath).toBe(generationHome(stack.temp, 1).paths.sockets.runtime);
    expect(second.handle.ready.socketPath).toBe(generationHome(stack.temp, 2).paths.sockets.runtime);
    expect(first.handle.ready.socketPath).not.toBe(second.handle.ready.socketPath);
  });

  it('executes every step of a run created through the newer generation exactly once while both generations claim', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const gatewaySocketPath = stack.temp.paths.sockets.gateway;
    await launchRuntime(stack.temp, { gatewaySocketPath, generation: 1 } as Parameters<typeof launchRuntime>[1]);
    await launchRuntime(stack.temp, { gatewaySocketPath, generation: 2 } as Parameters<typeof launchRuntime>[1]);
    const newer = clientOf(generationHome(stack.temp, 2));
    const session = await newer.createSession();
    const run = await newer.createRun(session.id);
    expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED', 'CANCELLED'])).toBe('COMPLETED');
    const responded = eventTypes(stack.temp, run.id).filter((type) => type === 'model.responded');
    expect(responded.length).toBeGreaterThan(0);
    expect(stack.completions()).toBe(responded.length);
    const attempts = readDb<{ attempts: number }>(stack.temp.paths.databases.runtime, 'SELECT attempts FROM runs WHERE id = ?', run.id);
    expect(attempts).toEqual([{ attempts: 1 }]);
  });
});
