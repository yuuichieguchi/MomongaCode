import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import type { RunEvent } from '@momonga/protocol';
import { createFidelityFold } from '../packages/runtime/src/memory/fidelity-fold.ts';

const specsDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');

const configurations = fs.readdirSync(specsDir).filter((name) => /^FidelityMemo\..*\.cfg$/.test(name));

const policyOf = (name: string): string | undefined => /^\s*D9\s*=\s*"(\w+)"\s*$/m.exec(fs.readFileSync(path.join(specsDir, name), 'utf8'))?.[1];

const TOKEN = 'make deploy-staging';

const at = (seq: number, payload: Record<string, unknown>): RunEvent => ({ id: seq, runId: 'run', sessionId: 's', seq, step: 0, leaseToken: 1, createdAt: 0, ...payload }) as unknown as RunEvent;

const call = (rawInput: unknown): RunEvent => at(1, { type: 'tool.call', callId: 'c', providerCallId: 'c', name: 'Sh', kind: 'other', title: 'c', rawInput });

const started = at(2, { type: 'tool.started', callId: 'c', idemKey: 'k', basis: 'read_only' });

const completed = (extra: Record<string, unknown> = {}): RunEvent => at(3, { type: 'tool.completed', callId: 'c', status: 'completed', output: 'ok', ...extra });

const reconciled = (outcome: string, output = 'ok'): RunEvent => at(3, { type: 'tool.reconciled', callId: 'c', outcome, output });

const attestedBy = (events: readonly RunEvent[], claim: 'executed' | 'any' = 'executed'): boolean => {
  const fold = createFidelityFold([{ token: TOKEN, claim }], '/work', () => {
    throw new Error('the scenario holds no reference event');
  });
  for (const event of events) fold.add(event);
  fold.finish();
  return fold.attested().length === 1;
};

const BEHAVIOUR = {
  completedUnrefused: true,
  completedDenied: false,
  completedNeverStarted: false,
  reconciledAlreadyApplied: true,
  reconciledNotApplied: false,
  reconciledUnknown: false,
  startedNeverCompleted: false,
  reconciledOutputAlreadyApplied: true,
  reconciledOutputNotApplied: true,
  reconciledOutputUnknown: true,
  userMessageExecutedClaim: false,
  userMessageAnyClaim: true,
};

const behaviourNow = () => ({
  completedUnrefused: attestedBy([call({ command: TOKEN }), started, completed()]),
  completedDenied: attestedBy([call({ command: TOKEN }), completed({ denial: { source: 'rule', reason: 'rule' } })]),
  completedNeverStarted: attestedBy([call({ command: TOKEN }), completed()]),
  reconciledAlreadyApplied: attestedBy([call({ command: TOKEN }), started, reconciled('already_applied')]),
  reconciledNotApplied: attestedBy([call({ command: TOKEN }), started, reconciled('not_applied')]),
  reconciledUnknown: attestedBy([call({ command: TOKEN }), started, reconciled('unknown')]),
  startedNeverCompleted: attestedBy([call({ command: TOKEN }), started]),
  reconciledOutputAlreadyApplied: attestedBy([call({ command: 'ls' }), started, reconciled('already_applied', TOKEN)]),
  reconciledOutputNotApplied: attestedBy([call({ command: 'ls' }), started, reconciled('not_applied', TOKEN)]),
  reconciledOutputUnknown: attestedBy([call({ command: 'ls' }), started, reconciled('unknown', TOKEN)]),
  userMessageExecutedClaim: attestedBy([at(1, { type: 'user.message', text: TOKEN })]),
  userMessageAnyClaim: attestedBy([at(1, { type: 'user.message', text: TOKEN })], 'any'),
});

describe('the fidelity fold and the models of specs/tla/FidelityMemo.tla cannot drift apart (AGENTS.md step 2)', () => {
  it('every configuration of the model names its policy for D9 item 1, either current or strict', () => {
    expect(configurations.length).toBeGreaterThan(0);
    for (const name of configurations) expect(['current', 'strict'], name).toContain(policyOf(name));
  });

  it('the policy the product implements, strict, is checked by a holding configuration with the same invariants as current', () => {
    const strict = configurations.filter((name) => policyOf(name) === 'strict');
    expect(strict.length).toBeGreaterThan(0);
    for (const name of strict) expect(name.replace('.strict', '.current'), name).toSatisfy((other: string) => configurations.includes(other));
  });

  it('the fold behaves as the strict policy: only already_applied offers the arguments and ends the call, the other outcomes end it without offering, a denial offers nothing, finish offers nothing', () => {
    expect(behaviourNow()).toEqual(BEHAVIOUR);
  });

  it('FIDELITY_FOLD_VERSION is bumped whenever the table above changes', () => {
    expect(FIDELITY_FOLD_VERSION).toBe(1);
  });
});
