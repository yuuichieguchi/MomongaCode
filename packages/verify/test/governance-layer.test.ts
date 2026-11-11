import { describe, expect, it } from 'vitest';
import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { hostFilesystemOf, NEVER_CANCELLED, testSecretLocations } from '@momonga/testkit';
import type { Witness } from '../src/decision-model.ts';
import { predictDecision } from '../src/queries.ts';
import { replayWitness } from '../src/replay.ts';
import { buildQueryContext } from '../src/verify.ts';
import { caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';

const z3 = useZ3();

const WITNESS: Witness = { kind: 'command', command: 'rm -rf build', defaultAllow: false };

const DYNAMIC: Witness = { kind: 'command', command: 'cat $(echo secrets/key)', defaultAllow: true };

const predictionFor = async (mode: PermissionMode, effect: 'deny' | 'ask', ruleText = 'Bash(rm:*)', witness: Witness = WITNESS) => {
  const layout = makeLayout();
  const fileSystem = caseSensitiveFs();
  const roots = [layout.project];
  const rules: PermissionRule[] = rulesOf(layout, [[effect, ruleText]]).map((rule) => ({ ...rule, layer: 'governance' }));
  const context = await buildQueryContext(z3.engine().api, { deniedLocations: testSecretLocations(layout.home), signal: NEVER_CANCELLED,
    rules,
    roots,
    mode,
    home: layout.home,
    cwd: layout.project,
    protectedSet: await protectedSetFor(roots, fileSystem),
    fs: hostFilesystemOf(fileSystem),
    secretLocations: [sshLocation(layout)],
    exemptDirectory: null,
    enforcement: ruleEnforcementOf('none'),
    budgetMs: 30_000,
  });
  const prediction = await predictDecision(context, 'Bash', witness);
  if (prediction === undefined) throw new Error('the model gave no prediction');
  return { prediction, replay: await replayWitness(context.env, 'Bash', witness, prediction) };
};

describe('the governance layer in the model', () => {
  it('predicts ask for a governance ask in bypass mode, in agreement with decide', async () => {
    const { prediction, replay } = await predictionFor('bypassPermissions', 'ask');
    expect(prediction.kind).toBe('ask');
    expect(replay).toMatchObject({ agrees: true, actual: 'ask' });
  });

  it.each(['bypassPermissions', 'manual'] as const)('predicts ask in %s mode for a path built at run time under a governance path rule, in agreement with decide', async (mode) => {
    const { prediction, replay } = await predictionFor(mode, 'ask', 'Read(secrets/**)', DYNAMIC);
    expect(prediction.kind).toBe('ask');
    expect(replay).toMatchObject({ agrees: true, actual: 'ask' });
  });

  it('adds the run-time path family to the model only for a governance rule, and makes no claim about it otherwise', async () => {
    const layout = makeLayout();
    const fileSystem = caseSensitiveFs();
    const roots = [layout.project];
    const context = await buildQueryContext(z3.engine().api, { deniedLocations: testSecretLocations(layout.home), signal: NEVER_CANCELLED,
      rules: rulesOf(layout, [['ask', 'Read(secrets/**)']]),
      roots,
      mode: 'bypassPermissions',
      home: layout.home,
      cwd: layout.project,
      protectedSet: await protectedSetFor(roots, fileSystem),
      fs: hostFilesystemOf(fileSystem),
      secretLocations: [sshLocation(layout)],
      exemptDirectory: null,
      enforcement: ruleEnforcementOf('none'),
      budgetMs: 30_000,
    });
    const prediction = await predictDecision(context, 'Bash', DYNAMIC);
    expect(prediction).toBeUndefined();
  });

  it('predicts deny for a governance deny in bypass mode', async () => {
    const { prediction, replay } = await predictionFor('bypassPermissions', 'deny');
    expect(prediction.kind).toBe('deny');
    expect(replay).toMatchObject({ agrees: true, actual: 'deny' });
  });
});
