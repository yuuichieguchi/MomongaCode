import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATE_KEY, gateOf, passingRecord } from '../auto-gate-fixtures.ts';
import type { AutoGateInput } from '../auto-gate-fixtures.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const SAFE = JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'writes a file the user asked for' });

const runWithGate = async (gate: AutoGateInput | undefined) => {
  const env = await makeEnv({ mode: 'auto' });
  env.settings.classifierAlias = 'guard';
  env.settings.autoGateValue = gate;
  env.gateway.capabilitiesByAlias['guard'] = capabilitiesFor(env.gateway.capabilitiesValue.contextWindow, { structuredOutput: 'json_schema' });
  const target = path.join(env.project, 'out.txt');
  env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]), textStep(SAFE), textStep('Written.'));
  const run = env.enqueue('Write out.txt');
  await env.runOnce(env.worker());
  return { env, run, target };
};

describe('a session already in auto stops trusting verdicts when its record goes stale', () => {
  it('still allows through the classifier while the record matches and passes', async () => {
    const { env, run, target } = await runWithGate(gateOf([passingRecord()]));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it.each([
    ['the classifier code changed', gateOf([passingRecord({ key: { ...GATE_KEY, codeDigest: 'older-classifier-code' } })])],
    ['the record is gone', gateOf([])],
    ['no gate is known', undefined],
    ['the record fails a bound', gateOf([passingRecord({ falseAllow: { successes: 1, trials: 75, high: 0.0721 } })])],
  ])('asks the person without calling the classifier when %s', async (_label, gate) => {
    const { env, run, target } = await runWithGate(gate);
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(fs.existsSync(target)).toBe(false);
    const [classified] = env.ofType(run.id, 'tool.permission.classified');
    expect(classified).toMatchObject({ outcome: 'ask' });
    expect(classified?.failure).toContain('momonga eval');
    expect(env.gateway.streams).toHaveLength(1);
  });
});
