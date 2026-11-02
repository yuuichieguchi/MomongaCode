import { describe, expect, it } from 'vitest';
import { protectedSetFor } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { hostFilesystemOf } from '@momonga/testkit';
import type { Witness } from '../src/decision-model.ts';
import { predictDecision } from '../src/queries.ts';
import { replayWitness } from '../src/replay.ts';
import { buildQueryContext } from '../src/verify.ts';
import { caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';

const z3 = useZ3();

const WITNESS: Witness = { kind: 'command', command: 'rm -rf build', defaultAllow: false };

const predictionFor = async (mode: PermissionMode, effect: 'deny' | 'ask') => {
  const layout = makeLayout();
  const fileSystem = caseSensitiveFs();
  const roots = [layout.project];
  const rules: PermissionRule[] = rulesOf(layout, [[effect, 'Bash(rm:*)']]).map((rule) => ({ ...rule, layer: 'governance' }));
  const context = buildQueryContext(z3.engine().api, {
    rules,
    roots,
    mode,
    home: layout.home,
    cwd: layout.project,
    protectedSet: protectedSetFor(roots, fileSystem),
    fs: hostFilesystemOf(fileSystem),
    secretLocations: [sshLocation(layout)],
    exemptDirectory: null,
    budgetMs: 30_000,
  });
  const prediction = await predictDecision(context, 'Bash', WITNESS);
  if (prediction === undefined) throw new Error('the model gave no prediction');
  return { prediction, replay: await replayWitness(context.env, 'Bash', WITNESS, prediction) };
};

describe('the governance layer in the model', () => {
  it('predicts ask for a governance ask in bypass mode, in agreement with decide', async () => {
    const { prediction, replay } = await predictionFor('bypassPermissions', 'ask');
    expect(prediction.kind).toBe('ask');
    expect(replay).toMatchObject({ agrees: true, actual: 'ask' });
  });

  it('predicts deny for a governance deny in bypass mode', async () => {
    const { prediction, replay } = await predictionFor('bypassPermissions', 'deny');
    expect(prediction.kind).toBe('deny');
    expect(replay).toMatchObject({ agrees: true, actual: 'deny' });
  });
});
