import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_MODES, POLICY_REFUTED_CODE } from '@momonga/protocol';
import { makeEnv } from '../worker/harness.ts';
import { textStep } from '../worker/scripts.ts';
import { SOLVER_GUARD_MS } from './rule-verdict-matrix-cells.ts';

const MODE_CALL = /^ruleVerdictMatrixOf\('([A-Za-z]+)'\);$/m;

describe('the files of the rule verdict matrix', () => {
  it('run every permission mode, one file each', () => {
    const modes = fs
      .readdirSync(import.meta.dirname)
      .filter((name) => /^rule-verdict-matrix-[A-Za-z]+\.test\.ts$/.test(name))
      .flatMap((name) => MODE_CALL.exec(fs.readFileSync(path.join(import.meta.dirname, name), 'utf8'))?.[1] ?? [])
      .sort();
    expect(modes).toEqual([...PERMISSION_MODES].sort());
  });
});

describe('a run of the worker with the decider of the product', () => {
  vi.setConfig({ testTimeout: SOLVER_GUARD_MS });

  it('in bypass mode, a rule set the decider refutes does not start: the run fails with policy_refuted before any model request', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.settings.extraRules.push({ effect: 'allow', rule: 'Read(~/**)' });
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: POLICY_REFUTED_CODE } });
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
  });
});
