import { describe, expect, it } from 'vitest';
import { EXECUTED_TEXT_EVENT_TYPES } from '@momonga/protocol';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { contributionAtTerminal } from '../../src/memory/contribution.ts';
import { FIDELITY_EVENT_TYPES } from '../../src/memory/fidelity-fold.ts';
import { REFLECTION_INPUT_EVENT_TYPES, reflectionInputFor } from '../../src/memory/reflection-input.ts';
import { capabilitiesFor } from '../worker/harness.ts';

const PROJECT = '/work/checks';

const journalOf = (payloads: readonly RunEventPayload[]): RunEvent[] =>
  payloads.map((payload, index) => ({ ...payload, id: index + 1, runId: 'run-checks', sessionId: 's', seq: index + 1, step: 1, leaseToken: 1, createdAt: 1 }) as RunEvent);

const check = (outcome: 'passed' | 'failed', output: string): RunEventPayload =>
  ({ type: 'verification.completed', round: 1, conditionId: 'c1', command: 'npm test', outcome, exitCode: outcome === 'passed' ? 0 : 1, durationMs: 3, output, mutationSeq: 0 }) as RunEventPayload;

describe('the reflection input shows what the run executed', () => {
  it('shows a check the runtime ran, with its command, its outcome and its output', () => {
    const input = reflectionInputFor(journalOf([{ type: 'user.message', text: 'fix the bug' }, check('passed', '12 tests passed')]), PROJECT, capabilitiesFor(8_000));
    expect(input).toContain('<check n="1" command="npm test" status="passed, exit code 0">');
    expect(input).toContain('12 tests passed');
  });

  it('shows the recorded result of a held call under the call it belongs to', () => {
    const events = journalOf([
      { type: 'user.message', text: 'deploy' },
      { type: 'tool.call', callId: 'h1', providerCallId: 'h1', name: 'Deploy', kind: 'other', title: 'Deploy staging', rawInput: {} },
      { type: 'tool.held.resolved', callId: 'h1', approvalId: 'a1', outcome: 'executed', status: 'completed', output: 'deployed build 41' },
    ]);
    const input = reflectionInputFor(events, PROJECT, capabilitiesFor(8_000));
    expect(input).toContain('<step n="1" tool="Deploy" title="Deploy staging" status="held, executed, completed">');
    expect(input).toContain('deployed build 41');
  });
});

describe('every fold over what a run executed or showed reads the one list of the protocol', () => {
  it.each([
    ['the fidelity fold', FIDELITY_EVENT_TYPES],
    ['the contribution measure', contributionAtTerminal.eventTypes],
    ['the reflection input', REFLECTION_INPUT_EVENT_TYPES],
  ] as const)('%s', (_name, types) => {
    expect(EXECUTED_TEXT_EVENT_TYPES).toEqual(['tool.call', 'tool.started', 'tool.completed', 'tool.reconciled', 'tool.held.resolved', 'verification.completed']);
    expect(types).toEqual(expect.arrayContaining([...EXECUTED_TEXT_EVENT_TYPES]));
  });
});
