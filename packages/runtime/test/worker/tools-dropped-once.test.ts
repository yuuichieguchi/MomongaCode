import { describe, expect, it } from 'vitest';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const SMALL_WINDOW = 1600;

const droppedNotices = (env: Env, runId: string): string[] =>
  env.ofType(runId, 'notice').flatMap((notice) => (notice.code === 'tools_dropped' ? [notice.message] : []));

const runOnce = async (env: Env, input: string): Promise<string> => {
  env.gateway.script.push(textStep('Done.'));
  const run = await env.enqueue(input, { history: 'fresh' });
  await env.runOnce(env.worker());
  expect(env.run(run.id).status).toBe('COMPLETED');
  return run.id;
};

describe('the notice of tools left out for a small window, across the runs of a session', () => {
  it('is written once per model and declared window, and again when the window changes', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(SMALL_WINDOW, { maxOutputTokens: 1024, tokenErrorRatio: 0.5 }) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };

    const first = await runOnce(env, 'one');
    const second = await runOnce(env, 'two');
    env.gateway.capabilitiesValue = capabilitiesFor(SMALL_WINDOW + 100, { maxOutputTokens: 1024, tokenErrorRatio: 0.5 });
    const third = await runOnce(env, 'three');

    expect(droppedNotices(env, first)).toHaveLength(1);
    expect(droppedNotices(env, first)[0]).toContain(`(${SMALL_WINDOW} tokens)`);
    expect(droppedNotices(env, first)[0]).toContain('raise the declared context window of that model, or shorten the instructions');
    expect(droppedNotices(env, second)).toEqual([]);
    expect(droppedNotices(env, third)).toHaveLength(1);
    expect(droppedNotices(env, third)[0]).toContain(`(${SMALL_WINDOW + 100} tokens)`);
  });
});
