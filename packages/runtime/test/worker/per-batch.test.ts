import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { itemCapFor, inputCeilingFor } from '@momonga/context';
import { canonicalJson } from '@momonga/foundation';
import { inputTokensOf, tokensOfText } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('worker re-reads session mode and rules for every batch', () => {
  it('applies a permission mode changed between batches', async () => {
    const env = await makeEnv({ mode: 'manual' });
    const target = path.join(env.project, 'mode.txt');
    env.toolbox.hooks['Echo'] = () => env.setMode('acceptEdits');
    env.gateway.script.push(
      callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'switch' } }]),
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'edited' } }]),
      textStep('Done.'),
    );
    const run = await env.enqueue('Switch mode then write');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('edited');
  });

  it('applies a rule appended between batches', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const target = path.join(env.project, 'blocked.txt');
    env.toolbox.hooks['Echo'] = () => {
      env.settings.extraRules.push({ effect: 'deny', rule: `Write(/${target})` });
    };
    env.gateway.script.push(
      callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'deny' } }]),
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'blocked' } }]),
      textStep('Done.'),
    );
    const run = await env.enqueue('Deny then write');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [completed] = env.ofType(run.id, 'tool.completed').filter((event) => event.callId === env.gateway.callId('call_w_1'));
    expect(completed?.status).toBe('failed');
    expect(completed?.output.startsWith('Permission denied')).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(env.settings.ruleReads).toBeGreaterThanOrEqual(2);
  });
});

describe('worker output fit per batch', () => {
  it.each([4000, 8000, 100_000])('derives the item cap of a %i token window from the pinned floor and the window', async (contextWindow) => {
    const capabilities = capabilitiesFor(contextWindow);
    const env = await makeEnv({ capabilities });
    env.gateway.script.push(callsStep([{ callId: 'call_p_1', name: 'Probe', args: { value: 'budget' } }]), textStep('Probed.'));
    const run = await env.enqueue('Probe');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [execution] = env.toolbox.executions;
    if (execution === undefined) throw new Error('expected the Probe execution');
    const pinnedTokens = inputTokensOf(env.gateway.streams[0]?.body ?? { model: 'fm' });
    const itemCap = itemCapFor(capabilities, inputCeilingFor(capabilities) - pinnedTokens);
    const tokensOf = (output: string): number => tokensOfText(canonicalJson({ type: 'function_call_output', call_id: execution.callId, output }));
    let low = 1;
    let high = 8 * itemCap;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (tokensOf('a'.repeat(middle)) <= itemCap) low = middle;
      else high = middle - 1;
    }
    expect(await execution.outputFit.fits('a'.repeat(low))).toBe(true);
    expect(await execution.outputFit.fits('a'.repeat(low + 4))).toBe(false);
  });
});
