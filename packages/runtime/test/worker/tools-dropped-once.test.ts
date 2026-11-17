import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { capabilitiesFor, fullToolsetPinnedTokens, makeEnv, smallestWindowWhosePinnedFloorAccepts } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const droppedNotices = (env: Env, runId: string): string[] =>
  env.ofType(runId, 'notice').flatMap((notice) => (notice.code === 'tools_dropped' ? [notice.message] : []));

const runOnce = async (env: Env, input: string): Promise<{ id: string; status: string }> => {
  env.gateway.script.push(textStep('Done.'));
  const run = await env.enqueue(input, { history: 'fresh' });
  await env.runOnce(env.worker());
  return { id: run.id, status: env.run(run.id).status };
};

const SEARCH_LIMIT = 400;

const attemptAt = async (window: number) => {
  const env = await makeEnv({ capabilities: capabilitiesFor(window, { maxOutputTokens: 1024, tokenErrorRatio: 0.5 }) });
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
  const first = await runOnce(env, 'one');
  const second = await runOnce(env, 'two');
  env.gateway.capabilitiesValue = capabilitiesFor(window + 100, { maxOutputTokens: 1024, tokenErrorRatio: 0.5 });
  const third = await runOnce(env, 'three');
  const served =
    [first, second, third].every((run) => run.status === 'COMPLETED') &&
    droppedNotices(env, first.id).length === 1 &&
    droppedNotices(env, second.id).length === 0 &&
    droppedNotices(env, third.id).length === 1;
  return { window, env, first, second, third, served };
};

describe('the notice of tools left out for a small window, across the runs of a session', () => {
  it('is written once per model and declared window, and again when the window changes', async () => {
    const fits = smallestWindowWhosePinnedFloorAccepts(await fullToolsetPinnedTokens('one'), (candidate) => capabilitiesFor(candidate, { maxOutputTokens: 1024 }));
    let attempt = await attemptAt(fits);
    for (let window = fits + 1; !attempt.served; window++) {
      if (window > fits + SEARCH_LIMIT) throw new Error('no window from the first one that keeps the whole toolset pinned serves the session with tools left out');
      attempt = await attemptAt(window);
    }
    const { window, env, first, second, third } = attempt;

    expect(droppedNotices(env, first.id)).toHaveLength(1);
    expect(droppedNotices(env, first.id)[0]).toContain(`(${window} tokens)`);
    expect(droppedNotices(env, first.id)[0]).toContain('raise the declared context window of that model, or shorten the instructions');
    expect(droppedNotices(env, second.id)).toEqual([]);
    expect(droppedNotices(env, third.id)).toHaveLength(1);
    expect(droppedNotices(env, third.id)[0]).toContain(`(${window + 100} tokens)`);
  });
});
