import { describe, expect, it, vi } from 'vitest';
import { generationLayout, syncPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeKernelLock, prepareGenerationForTest } from '@momonga/testkit';
import { GENERATION_POLL_INTERVAL_MS, MANY_GENERATIONS_THRESHOLD } from '../src/constants.ts';
import { TEST_VERSION, pump, pumpUntil, startHarness } from './fixtures/p3-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('the warning of many live generations (design 20.76)', () => {
  it('is written once per change of the live count above the threshold, at the poll of the serving supervisor', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const earlier = [1, 2, 3] as const;
    const supervisorLockOf = (home: string, generation: number): string => generationLayout(syncPaths.canonicalPath(home), generation).locks.supervisor;
    const h = await startHarness(context, {
      generation: 4,
      prepare: (home) => {
        for (const generation of earlier) {
          prepareGenerationForTest(home, generation, TEST_VERSION);
          lock.holdExternally(supervisorLockOf(home, generation), 4_300_000 + generation);
        }
      },
      overrides: { lockMechanism: lock },
    });
    const many = (): unknown[] => h.log.withMsg('generation.many').map((line) => line['live']);
    await pumpUntil(h.timers, () => h.supervisor.role() === 'serving', { realWork: h.realWork, maxMs: 5000, description: 'the generation to serve' });
    expect(MANY_GENERATIONS_THRESHOLD).toBe(3);
    expect(many()).toEqual([]);
    await pump(h.timers, h.realWork, GENERATION_POLL_INTERVAL_MS);
    expect(many()).toEqual([4]);
    await pump(h.timers, h.realWork, 3 * GENERATION_POLL_INTERVAL_MS);
    expect(many()).toEqual([4]);
    lock.releaseExternally(supervisorLockOf(h.home, 1));
    await pump(h.timers, h.realWork, 2 * GENERATION_POLL_INTERVAL_MS);
    expect(many()).toEqual([4]);
    lock.holdExternally(supervisorLockOf(h.home, 1), 4_300_001);
    await pump(h.timers, h.realWork, 2 * GENERATION_POLL_INTERVAL_MS);
    expect(many()).toEqual([4, 4]);
    expect(h.log.withMsg('generation.many').every((line) => line['level'] === 'warn')).toBe(true);
  });
});
