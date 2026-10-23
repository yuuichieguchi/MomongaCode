import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('worker re-reads session mode and rules for every batch', () => {
  it('applies a permission mode changed between batches', async () => {
    const env = await makeEnv({ mode: 'default' });
    const target = path.join(env.project, 'mode.txt');
    env.toolbox.hooks['Echo'] = () => env.setMode('acceptEdits');
    env.gateway.script.push(
      callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'switch' } }]),
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'edited' } }]),
      textStep('Done.'),
    );
    const run = env.enqueue('Switch mode then write');

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
    const run = env.enqueue('Deny then write');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [completed] = env.ofType(run.id, 'tool.completed').filter((event) => event.callId === 'call_w_1');
    expect(completed?.status).toBe('failed');
    expect(completed?.output.startsWith('Permission denied')).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(env.settings.ruleReads).toBeGreaterThanOrEqual(2);
  });
});

describe('worker inline output limit per batch', () => {
  it.each([
    [4000, 2190],
    [8000, 4380],
    [100_000, 30_000],
  ])('derives the inline limit from a %i token window as %i characters', async (contextWindow, expected) => {
    const env = await makeEnv({ capabilities: capabilitiesFor(contextWindow) });
    env.gateway.script.push(callsStep([{ callId: 'call_p_1', name: 'Probe', args: { value: 'budget' } }]), textStep('Probed.'));
    const run = env.enqueue('Probe');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.executions.map((execution) => execution.outputBudgetChars)).toEqual([expected]);
  });
});
