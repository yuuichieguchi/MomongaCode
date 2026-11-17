import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { inputCeilingFor, pinnedFloorFor } from '@momonga/context';
import type { Capabilities } from '@momonga/protocol';
import { inputTokensOf, tokensOfText } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

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
  const FLOOR_WINDOW = 1500;
  const pinnedSmall = (): Capabilities => capabilitiesFor(FLOOR_WINDOW, { maxOutputTokens: 1024 });
  const listedSmall = (): Capabilities => capabilitiesFor(2 * FLOOR_WINDOW, { maxOutputTokens: 1024, tokenErrorRatio: LIVE_RATIO });

  it('reads the ratio from the claim listing and keeps the pinned window, so the resumed build leaves out tools for room', async () => {
    const env = await makeEnv({ capabilities: pinnedSmall() });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'approved' } }]));
    const run = await env.enqueue('Write it');

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const firstBody = env.gateway.streams[0]?.body;
    if (firstBody === undefined) throw new Error('the first claim made no model call');
    const stable = inputTokensOf(firstBody) - tokensOfText(canonicalJson((firstBody.input as unknown[]).at(-1)));
    expect(stable).toBeLessThanOrEqual(pinnedFloorFor(pinnedSmall()));
    expect(stable).toBeGreaterThan(pinnedFloorFor(capabilitiesFor(FLOOR_WINDOW, { maxOutputTokens: 1024, tokenErrorRatio: LIVE_RATIO })));
    expect(stable).toBeLessThanOrEqual(pinnedFloorFor(listedSmall()));
    expect(env.ofType(run.id, 'notice').map((notice) => notice.code)).not.toContain('tools_dropped');
    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));

    env.gateway.capabilitiesValue = listedSmall();
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    const secondBody = env.gateway.streams[1]?.body;
    if (secondBody === undefined) throw new Error('the resumed claim made no model call');
    expect((secondBody.tools ?? []).length).toBeLessThan((firstBody.tools ?? []).length);
    expect(env.ofType(run.id, 'notice').map((notice) => notice.code)).toContain('tools_dropped');
  });
});

