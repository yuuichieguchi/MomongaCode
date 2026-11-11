import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withFileLock } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { createFakeKernelLock, sleepDrivenTiming, createFakeRandom } from '@momonga/testkit';
import { createCallLocks } from '../packages/tools/src/call-lock.ts';

const sourceOf = (relative: string): string => fs.readFileSync(path.resolve(import.meta.dirname, '..', relative), 'utf8');

const ADAPTERS = ['packages/foundation/src/file-lock.ts', 'packages/tools/src/call-lock.ts'];

const recordingTiming = (): Timing & { sleeps: number[] } => {
  let current = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    ...sleepDrivenTiming({
      now: () => current,
      sleep: async (ms) => {
        current += ms;
        sleeps.push(ms);
      },
    }),
  };
};

describe('the one claim loop', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter} delegates to claimWithin and holds no loop or claim of its own`, () => {
      const source = sourceOf(adapter);
      expect(source).toMatch(/claimWithin\(/);
      expect(source).not.toMatch(/for \(;;\)|while \(/);
      expect(source).not.toMatch(/\.claim\(|acquireProcessLock\(/);
    });
  }

  it('polls at one interval for both kinds of lock', async () => {
    const lockPath = '/locks/a.lock';
    const fake = { ...createFakeKernelLock({ inheritable: false }), claim: async () => ({ kind: 'held' as const }), readHolder: async () => undefined };
    const fileTiming = recordingTiming();
    const callTiming = recordingTiming();

    await withFileLock(lockPath, async () => undefined, {
      ports: { timing: fileTiming, random: createFakeRandom(1) },
      mechanism: fake,
      timeoutMs: 100,
    }).catch(() => undefined);
    await createCallLocks({ dir: '/locks', mechanism: fake, timing: callTiming, waitMs: 100 })
      .acquire('a', new AbortController().signal)
      .catch(() => undefined);

    expect(fileTiming.sleeps.length).toBeGreaterThan(0);
    expect(new Set(fileTiming.sleeps)).toEqual(new Set(callTiming.sleeps));
  });
});
