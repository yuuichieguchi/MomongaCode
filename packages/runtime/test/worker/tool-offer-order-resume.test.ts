import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { FunctionTool } from '@momonga/protocol';
import { FULL_TOOLSET_WINDOW, capabilitiesFor, makeEnv, smallestWindowWhosePinnedFloorAccepts } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { inputTokensOf } from './fake-gateway.ts';
import type { CreateResponseBody } from '@momonga/protocol';

const LOADER = 'LoadTools';
const WORK_TOOLS = ['Echo', 'Counter', 'Write'];
const LIVE_RATIO = 0.5;

const namesOf = (body: unknown): string[] => ((body as { tools?: FunctionTool[] }).tools ?? []).map((tool) => tool.name);
const withoutLoader = (names: readonly string[]): string[] => names.filter((name) => name !== LOADER);

const workTools = (env: Env) => () => env.toolbox.tools().filter((tool) => WORK_TOOLS.includes(tool.name));

const SEARCH_LIMIT = 1000;
const WINDOW_STEP = 25;

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const pinnedDigestsOf = (env: Env, runId: string): string[] =>
  env.ofType(runId, 'run.started').map((event) => (event.pins as { toolSetDigest: string }).toolSetDigest);

const firstPassAt = async (window: number) => {
  const env = await makeEnv({ capabilities: capabilitiesFor(window, { maxOutputTokens: 1024 }) });
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: true };
  const warm = env.worker('warm', { toolList: workTools(env) });
  for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
    env.gateway.script.push(callsStep([{ callId: `warm-${index}`, name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
    await env.enqueue(`warm ${index}`, { history: 'fresh' });
    await env.runOnce(warm);
  }
  env.gateway.script.push(
    callsStep([{ callId: 'load-1', name: LOADER, args: { names: ['Counter', 'Write'] } }]),
    callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'one' } }]),
  );
  const run = await env.enqueue('Use the tools', { history: 'fresh' });
  await env.runOnce(env.worker('worker-1', { toolList: workTools(env) }));
  return { env, run };
};

const fourToolBodyTokens = async (): Promise<number> => {
  const { env, run } = await firstPassAt(FULL_TOOLSET_WINDOW);
  const second = env.ofType(run.id, 'model.requested')[1]?.body;
  if (second === undefined || second === null) throw new Error('the first pass at the full window made no second model call');
  return inputTokensOf(second as CreateResponseBody);
};

const attemptAt = async (window: number, resumeWindow: number) => {
  const { env, run } = await firstPassAt(window);
  expect(env.run(run.id).status).toBe('WAITING_HUMAN');
  const beforeResume = env.ofType(run.id, 'model.requested').map((event) => withoutLoader(namesOf(event.body)));
  expect(beforeResume).toEqual([['Echo'], ['Echo', 'Counter', 'Write']]);
  expect(env.ofType(run.id, 'model.requested').map((event) => namesOf(event.body))).toEqual([[LOADER, 'Echo'], [LOADER, 'Echo', 'Counter', 'Write']]);
  const digestsBefore = pinnedDigestsOf(env, run.id);

  await env.resolveApproval(run.id, 'allow_once');
  env.gateway.script.push(textStep('Written.'));
  env.gateway.capabilitiesValue = capabilitiesFor(resumeWindow, { maxOutputTokens: 1024, tokenErrorRatio: LIVE_RATIO });
  await env.runOnce(env.worker('worker-2', { toolList: workTools(env) }));

  const resumed = namesOf(env.ofType(run.id, 'model.requested').at(-1)?.body);
  const served = env.run(run.id).status === 'COMPLETED' && env.ofType(run.id, 'notice').some((notice) => notice.code === 'tools_dropped') && resumed.length === 3 && resumed[2] === 'Counter' && !resumed.includes('Write');
  return { window, resumeWindow, env, run, digestsBefore, served };
};

describe('decision 52 across a resume whose build drops a tool', () => {
  it('keeps the offered order of the remaining tools, the pinned digest, and records no tools_changed', async () => {
    const fits = smallestWindowWhosePinnedFloorAccepts(await fourToolBodyTokens(), (candidate) => capabilitiesFor(candidate, { maxOutputTokens: 1024 }));
    let attempt = await attemptAt(fits, 2 * fits);
    for (let window = fits + WINDOW_STEP; !attempt.served; window += WINDOW_STEP) {
      if (window > fits + SEARCH_LIMIT) throw new Error('no window from the first one that pins the four tools serves the resumed build with the write tool left out');
      attempt = await attemptAt(window, 2 * window);
    }
    const { env, run, digestsBefore } = attempt;

    expect(env.run(run.id).status).toBe('COMPLETED');
    const resumed = namesOf(env.ofType(run.id, 'model.requested').at(-1)?.body);
    expect(resumed).not.toContain('Write');
    expect(env.ofType(run.id, 'notice').map((notice) => notice.code)).toContain('tools_dropped');
    expect(withoutLoader(resumed)).toEqual(['Echo', 'Counter']);
    expect(resumed).toEqual([LOADER, 'Echo', 'Counter']);
    expect(new Set(pinnedDigestsOf(env, run.id))).toEqual(new Set(digestsBefore));
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tools_changed')).toEqual([]);
  });
});
