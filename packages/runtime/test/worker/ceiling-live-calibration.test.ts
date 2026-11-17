import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { inputCeilingFor, pinnedFloorFor } from '@momonga/context';
import type { Capabilities } from '@momonga/protocol';
import { inputTokensOf, tokensOfText } from './fake-gateway.ts';
import { capabilitiesFor, fullToolsetPinnedTokens, makeEnv, smallestWindowWhosePinnedFloorAccepts } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const WINDOW = 8192;
const LIVE_RATIO = 0.5;

const pinned = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: 1024 });
const liveListing = (): Capabilities => capabilitiesFor(2 * WINDOW, { maxOutputTokens: 1024, tokenErrorRatio: LIVE_RATIO });

const overheadTokens = async (): Promise<number> => {
  const env = await makeEnv({ capabilities: pinned() });
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
  env.gateway.script.push(textStep('Done.'));
  await env.enqueue('x');
  await env.runOnce(env.worker());
  const body = env.gateway.streams[0]?.body;
  if (body === undefined) throw new Error('the measuring run made no model call');
  return inputTokensOf(body) - tokensOfText('x');
};

describe('the build ceiling of a claim resumed after the calibration of the model targets changed', () => {
  it('reads the ratio from the claim listing and keeps the pinned window', async () => {
    const pinnedCeiling = inputCeilingFor(pinned());
    const liveCeiling = inputCeilingFor(capabilitiesFor(WINDOW, { maxOutputTokens: 1024, tokenErrorRatio: LIVE_RATIO }));
    expect(liveCeiling).toBeLessThan(pinnedCeiling);
    expect(inputCeilingFor(liveListing())).not.toBe(liveCeiling);
    const wanted = Math.floor((pinnedCeiling + liveCeiling) / 2) - (await overheadTokens());
    const env = await makeEnv({ capabilities: pinned() });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'approved' } }]));
    const run = await env.enqueue('y'.repeat(4 * wanted));

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const firstBody = env.gateway.streams[0]?.body;
    if (firstBody === undefined) throw new Error('the first claim made no model call');
    expect(inputTokensOf(firstBody)).toBeGreaterThan(liveCeiling);
    expect(inputTokensOf(firstBody)).toBeLessThan(pinnedCeiling);
    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('never sent'));

    env.gateway.capabilitiesValue = liveListing();
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error?.code).toBe('pinned_overflow');
    expect(failed.error?.message).toContain(`but at most ${liveCeiling} fit (window ${WINDOW},`);
    expect(env.gateway.streams).toHaveLength(1);
  });
});

describe('the tool floor of a claim resumed after the calibration of the model targets changed', () => {
  const pinnedOf = (window: number): Capabilities => capabilitiesFor(window, { maxOutputTokens: 1024 });
  const liveOf = (window: number): Capabilities => capabilitiesFor(window, { maxOutputTokens: 1024, tokenErrorRatio: LIVE_RATIO });
  const listedOf = (window: number): Capabilities => capabilitiesFor(2 * window, { maxOutputTokens: 1024, tokenErrorRatio: LIVE_RATIO });

  type Attempt = { window: number; env: Env; runId: string; firstTools: number; secondTools: number; stable: number; served: boolean };

  const attemptAt = async (window: number): Promise<Attempt> => {
    const env = await makeEnv({ capabilities: pinnedOf(window) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'approved' } }]));
    const run = await env.enqueue('Write it');
    await env.runOnce(env.worker('worker-1'));
    const firstBody = env.gateway.streams[0]?.body;
    if (firstBody === undefined) throw new Error('the first claim made no model call');
    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));
    env.gateway.capabilitiesValue = listedOf(window);
    await env.runOnce(env.worker('worker-2'));
    const secondBody = env.gateway.streams[1]?.body;
    const firstTools = (firstBody.tools ?? []).length;
    const secondTools = (secondBody?.tools ?? []).length;
    const served = env.run(run.id).status === 'COMPLETED' && secondBody !== undefined && secondTools < firstTools;
    return { window, env, runId: run.id, firstTools, secondTools, stable: inputTokensOf(firstBody), served };
  };

  const SEARCH_LIMIT = 400;

  it('reads the ratio from the claim listing and keeps the pinned window, so the resumed build leaves out tools for room', async () => {
    const fits = smallestWindowWhosePinnedFloorAccepts(await fullToolsetPinnedTokens('Write it'), pinnedOf);
    let attempt = await attemptAt(fits);
    for (let window = fits + 1; !attempt.served; window++) {
      if (window > fits + SEARCH_LIMIT) throw new Error('no window from the first one that keeps the whole toolset pinned leaves the resumed build served with tools left out');
      attempt = await attemptAt(window);
    }
    const { window, env, runId, stable } = attempt;

    expect(stable).toBeLessThanOrEqual(pinnedFloorFor(pinnedOf(window)));
    expect(stable).toBeGreaterThan(pinnedFloorFor(liveOf(window)));
    expect(stable).toBeLessThanOrEqual(pinnedFloorFor(listedOf(window)));
    expect(env.run(runId).status).toBe('COMPLETED');
    expect(env.ofType(runId, 'notice').map((notice) => notice.code)).toContain('tools_dropped');
    expect(attempt.secondTools).toBeLessThan(attempt.firstTools);
  });
});
