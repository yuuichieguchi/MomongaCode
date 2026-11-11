import fs from 'node:fs';
import path from 'node:path';
import { loadUserSettings } from '@momonga/config';
import { describe, expect, it } from 'vitest';
import { declaredMandateOf } from '../../src/service/delegation.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const heldWrite = (env: Env) => ({ callId: 'call_w', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'held content' } });

const settingsWith = async (env: Env, onQuiescent: 'report' | 'wait' | undefined) => {
  const directory = path.join(env.home, '.momonga');
  fs.mkdirSync(directory, { recursive: true });
  const night = { ask: [`Write(/${path.join(env.project, 'out.txt')})`], ...(onQuiescent === undefined ? {} : { onQuiescent }) };
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ mandates: { night } }));
  return (await loadUserSettings({ home: env.home, signal: new AbortController().signal })).settings;
};

const quiescentOf = async (onQuiescent: 'report' | 'wait' | undefined) => {
  const env = await makeEnv();
  const settings = await settingsWith(env, onQuiescent);
  const mandate = declaredMandateOf({ profile: 'night' }, settings);
  if (mandate === undefined) throw new Error('the mandate named night was not declared');
  env.gateway.script.push(callsStep([heldWrite(env)]), textStep('Done except the write.'));
  const run = await env.enqueue('Write', { mandate });
  await env.runOnce(env.worker());
  expect(env.run(run.id).status).toBe('WAITING_HUMAN');
  const events = env.ofType(run.id, 'run.quiescent');
  expect(events).toHaveLength(1);
  return events[0];
};

describe('the quiescence report of a run carries what its mandate resolved to for the client that acts on it', () => {
  it('carries wait when the mandate of the user settings says wait', async () => {
    expect(await quiescentOf('wait')).toMatchObject({ onQuiescent: 'wait' });
  });

  it('carries report when the mandate of the user settings says report', async () => {
    expect(await quiescentOf('report')).toMatchObject({ onQuiescent: 'report' });
  });

  it('carries no value when the mandate states none, so each client applies its own rule', async () => {
    expect(await quiescentOf(undefined)).not.toHaveProperty('onQuiescent');
  });
});
