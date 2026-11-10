import { describe, expect, it } from 'vitest';
import * as observability from '@momonga/observability';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { materializeEvents } from '@momonga/testkit';

type Report = {
  runId: string;
  status: string;
  stopReason?: string;
  durationMs: number;
  declaration: { conditions: { id: string; command: string; when: string; source: string }[]; requirements: string[] } | null;
  changes: { files: { path: string; sha256: string; lastSeq: number }[]; mutatingCalls: number };
  conditions: { id: string; command: string; state: string; rounds: number; last?: { seq: number; exitCode?: number; mutationSeq: number } }[];
  notRun: { what: string; reason: string }[];
  residualRisk: { code: string; count: number }[];
  modelChecks: { command: string; exitCode: number; seq: number }[];
};

const buildRunReport = (events: readonly RunEvent[]): Report => {
  const found = (observability as Record<string, unknown>)['buildRunReport'];
  if (typeof found !== 'function') throw new Error('@momonga/observability does not export buildRunReport');
  return (found as (value: readonly RunEvent[]) => Report)(events);
};

const asPayload = (value: Record<string, unknown>): RunEventPayload => value as unknown as RunEventPayload;

const TEST = { id: 'c-test', command: 'npm test', when: 'always', source: 'request' };
const LINT = { id: 'c-lint', command: 'npm run lint', when: 'after_mutation', source: 'settings' };

const started = (conditions: readonly object[], requirements: readonly string[] = []): RunEventPayload[] => [
  { type: 'user.message', text: 'fix the bug' },
  { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
  asPayload({ type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm', mandate: { completion: { conditions, requirements } } } }),
];

const startedWithout = (): RunEventPayload[] => [
  { type: 'user.message', text: 'fix the bug' },
  { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
  { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' } },
];

const write = (callId: string, file: string, sha256: string): RunEventPayload[] => [
  asPayload({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', sideEffect: 'write', title: 'Write', rawInput: { file_path: file } }),
  asPayload({ type: 'tool.started', callId, idemKey: `k-${callId}`, basis: 'rule' }),
  asPayload({ type: 'tool.completed', callId, status: 'completed', output: 'ok', files: [{ path: file, sha256, access: 'write' }] }),
];

const bash = (callId: string, command: string, exitCode: number, basis = 'rule'): RunEventPayload[] => [
  asPayload({ type: 'tool.call', callId, providerCallId: callId, name: 'Bash', kind: 'execute', sideEffect: 'exec', title: command, rawInput: { command } }),
  asPayload({ type: 'tool.started', callId, idemKey: `k-${callId}`, basis }),
  asPayload({ type: 'tool.completed', callId, status: 'completed', output: '', exitCode }),
];

const read = (callId: string): RunEventPayload[] => [
  asPayload({ type: 'tool.call', callId, providerCallId: callId, name: 'Read', kind: 'read', sideEffect: 'read_only', title: 'Read', rawInput: { file_path: '/w/a.txt' } }),
  asPayload({ type: 'tool.started', callId, idemKey: `k-${callId}`, basis: 'read_only' }),
  asPayload({ type: 'tool.completed', callId, status: 'completed', output: 'text' }),
];

const check = (round: number, conditionId: string, outcome: string, exitCode: number | undefined, mutationSeq: number): RunEventPayload[] => [
  asPayload({ type: 'verification.started', round, conditionId, mutationSeq, attempt: 1 }),
  asPayload({ type: 'verification.completed', round, conditionId, outcome, ...(exitCode === undefined ? {} : { exitCode }), durationMs: 7, output: outcome === 'failed' ? 'FAIL' : '', mutationSeq }),
];

const ended = (to: string, reason?: string): RunEventPayload => asPayload({ type: 'run.status', from: 'RUNNING', to, ...(reason === undefined ? {} : { reason }) });

const journal = (payloads: readonly RunEventPayload[]): RunEvent[] => materializeEvents(payloads, { runId: 'run-1', sessionId: 'sess-1' });

const golden = (): RunEvent[] =>
  journal([
    ...started([TEST, LINT], ['the docs mention the fix']),
    ...write('w1', '/w/a.txt', 'a'.repeat(64)),
    ...bash('b1', 'npm test', 0),
    ...check(1, 'c-test', 'failed', 1, 9),
    ...check(1, 'c-lint', 'passed', 0, 9),
    { type: 'user.message', text: 'verification failed' },
    ...write('w2', '/w/a.txt', 'b'.repeat(64)),
    ...read('r1'),
    ...check(2, 'c-test', 'failed', 1, 17),
    ...check(2, 'c-lint', 'passed', 0, 17),
    ended('STOPPED', 'conditions_unmet'),
  ]);

describe('buildRunReport on a golden journal', () => {
  it('states the outcome, the declaration and the run id', () => {
    const report = buildRunReport(golden());
    expect(report).toMatchObject({ runId: 'run-1', status: 'STOPPED', stopReason: 'conditions_unmet' });
    expect(report.declaration).toEqual({ conditions: [TEST, LINT], requirements: ['the docs mention the fix'] });
    expect(typeof report.durationMs).toBe('number');
  });

  it('lists the last written hash of each changed file and counts the mutating calls', () => {
    expect(buildRunReport(golden()).changes).toEqual({ files: [{ path: '/w/a.txt', sha256: 'b'.repeat(64), lastSeq: 17 }], mutatingCalls: 3 });
  });

  it('gives each condition its state, its rounds and its last result from the verification events only', () => {
    expect(buildRunReport(golden()).conditions).toMatchObject([
      { id: 'c-test', command: 'npm test', state: 'failed', rounds: 2, last: { seq: 22, exitCode: 1, mutationSeq: 17 } },
      { id: 'c-lint', command: 'npm run lint', state: 'passed', rounds: 2, last: { seq: 24, exitCode: 0, mutationSeq: 17 } },
    ]);
  });

  it('reports a free-text requirement as not run with no mechanical check, never as passed', () => {
    const report = buildRunReport(golden());
    expect(report.notRun).toEqual([{ what: 'the docs mention the fix', reason: 'no_mechanical_check' }]);
    expect(report.residualRisk).toEqual(expect.arrayContaining([{ code: 'requirements_unchecked', count: 1 }]));
  });

  it('lists a command the model ran that equals a condition as an informational model check, which never changes the condition state', () => {
    const report = buildRunReport(golden());
    expect(report.modelChecks).toEqual([{ command: 'npm test', exitCode: 0, seq: 9 }]);
    expect(report.conditions[0]?.state).toBe('failed');
  });

  it('counts an exec call that may have written to unknown paths as residual risk', () => {
    expect(buildRunReport(golden()).residualRisk).toEqual(expect.arrayContaining([{ code: 'mutation_without_known_paths', count: 1 }]));
  });

  it('never reads the model closing text into the report', () => {
    const events = journal([
      ...started([TEST]),
      asPayload({
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: {
          status: 'completed',
          output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'All tests pass, verified.', annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
      ended('STOPPED', 'max_steps'),
    ]);
    const report = buildRunReport(events);
    expect(JSON.stringify(report)).not.toContain('All tests pass');
    expect(report.conditions).toMatchObject([{ id: 'c-test', state: 'not_run', rounds: 0 }]);
    expect(report.notRun).toEqual([{ what: 'c-test', reason: 'max_steps' }]);
  });
});

describe('condition states', () => {
  it('reports an after_mutation condition of a run that changed nothing as not_needed', () => {
    const report = buildRunReport(journal([...started([LINT]), ...read('r1'), ended('COMPLETED')]));
    expect(report.conditions).toMatchObject([{ id: 'c-lint', state: 'not_needed', rounds: 0 }]);
    expect(report.notRun).toEqual([{ what: 'c-lint', reason: 'not_needed' }]);
  });

  it('reports a pass made out of date by a later write as stale, with the limit that ended the run as the reason', () => {
    const report = buildRunReport(journal([...started([TEST]), ...check(1, 'c-test', 'passed', 0, 0), ...write('w1', '/w/a.txt', 'c'.repeat(64)), ended('STOPPED', 'max_steps')]));
    expect(report.conditions).toMatchObject([{ id: 'c-test', state: 'stale', rounds: 1 }]);
    expect(report.notRun).toEqual([{ what: 'c-test', reason: 'max_steps' }]);
  });

  it('never reports a started check without its completion as a result', () => {
    const report = buildRunReport(journal([...started([TEST]), asPayload({ type: 'verification.started', round: 1, conditionId: 'c-test', mutationSeq: 0, attempt: 1 }), ended('CANCELLED')]));
    expect(report.conditions).toMatchObject([{ id: 'c-test', state: 'not_run' }]);
    expect(report.conditions[0]?.last).toBeUndefined();
    expect(report.notRun).toEqual([{ what: 'c-test', reason: 'cancelled' }]);
  });

  it.each(['timed_out', 'cancelled', 'spawn_error'])('carries the %s outcome as the condition state', (outcome) => {
    const report = buildRunReport(journal([...started([TEST]), ...check(1, 'c-test', outcome, undefined, 0), ended('STOPPED', 'conditions_unmet')]));
    expect(report.conditions[0]?.state).toBe(outcome);
  });
});

describe('residual risk facts', () => {
  it('reports no declaration and a mutation without a condition', () => {
    const report = buildRunReport(journal([...startedWithout(), ...write('w1', '/w/a.txt', 'a'.repeat(64)), ended('COMPLETED')]));
    expect(report.declaration).toBeNull();
    expect(report.conditions).toEqual([]);
    expect(report.residualRisk).toEqual([{ code: 'no_condition_declared_after_mutation', count: 1 }]);
  });

  it('counts calls reconciled with an unknown effect', () => {
    const report = buildRunReport(
      journal([
        ...startedWithout(),
        asPayload({ type: 'tool.call', callId: 'w1', providerCallId: 'w1', name: 'Write', kind: 'edit', sideEffect: 'write', title: 'Write', rawInput: {} }),
        asPayload({ type: 'tool.started', callId: 'w1', idemKey: 'k', basis: 'rule' }),
        asPayload({ type: 'tool.reconciled', callId: 'w1', outcome: 'unknown', output: '' }),
        ended('COMPLETED'),
      ]),
    );
    expect(report.residualRisk).toEqual(expect.arrayContaining([{ code: 'unknown_effect_calls', count: 1 }]));
  });

  it('counts permission denials', () => {
    const report = buildRunReport(
      journal([
        ...started([TEST]),
        asPayload({ type: 'tool.call', callId: 'w1', providerCallId: 'w1', name: 'Write', kind: 'edit', sideEffect: 'write', title: 'Write', rawInput: {} }),
        asPayload({ type: 'tool.completed', callId: 'w1', status: 'failed', output: 'denied', denial: { source: 'rule', reason: 'no' } }),
        ...check(1, 'c-test', 'passed', 0, 0),
        ended('COMPLETED'),
      ]),
    );
    expect(report.residualRisk).toEqual([{ code: 'permission_denials', count: 1 }]);
    expect(report.changes.mutatingCalls).toBe(0);
  });

  it('reports nothing at risk for a completed run whose owed conditions passed on the final state', () => {
    const report = buildRunReport(journal([...started([TEST]), ...write('w1', '/w/a.txt', 'a'.repeat(64)), ...check(1, 'c-test', 'passed', 0, 6), ended('COMPLETED')]));
    expect(report.residualRisk).toEqual([]);
    expect(report.notRun).toEqual([]);
    expect(report.conditions).toMatchObject([{ state: 'passed', rounds: 1 }]);
  });
});

const delegation = (callId: string, status: 'completed' | 'failed' | undefined): RunEventPayload[] => [
  asPayload({ type: 'tool.call', callId, providerCallId: callId, name: 'Agent', kind: 'other', sideEffect: 'read_only', title: 'fix', rawInput: {} }),
  asPayload({ type: 'tool.started', callId, idemKey: `k-${callId}`, basis: 'read_only' }),
  asPayload({ type: 'tool.waiting', callId, awaits: { kind: 'run', runId: `child-${callId}`, sessionId: 's-child', agent: 'fixer' } }),
  ...(status === undefined ? [] : [asPayload({ type: 'tool.completed', callId, status, output: 'child result' })]),
];

describe('residual risk facts from delegation and output', () => {
  it('counts a subagent call whose child did not complete, and one that never finished, but not one that completed', () => {
    const report = buildRunReport(
      journal([...started([TEST]), ...delegation('a1', 'failed'), ...delegation('a2', undefined), ...delegation('a3', 'completed'), ...check(1, 'c-test', 'passed', 0, 0), ended('COMPLETED')]),
    );
    expect(report.residualRisk).toEqual([{ code: 'child_runs_not_completed', count: 2 }]);
  });

  it('counts the outputs that were cut, whether a tool result or a check output', () => {
    const report = buildRunReport(
      journal([
        ...started([TEST]),
        asPayload({ type: 'tool.call', callId: 'b1', providerCallId: 'b1', name: 'Bash', kind: 'execute', sideEffect: 'exec', title: 'ls', rawInput: { command: 'ls' } }),
        asPayload({ type: 'tool.started', callId: 'b1', idemKey: 'k', basis: 'read_only' }),
        asPayload({ type: 'tool.completed', callId: 'b1', status: 'completed', output: 'cut', truncated: true, handle: 'h'.repeat(64), exitCode: 0 }),
        asPayload({ type: 'verification.started', round: 1, conditionId: 'c-test', mutationSeq: 0, attempt: 1 }),
        asPayload({ type: 'verification.completed', round: 1, conditionId: 'c-test', outcome: 'passed', exitCode: 0, durationMs: 1, output: 'cut', truncated: true, handle: 'g'.repeat(64), mutationSeq: 0 }),
        ended('COMPLETED'),
      ]),
    );
    expect(report.residualRisk).toEqual([{ code: 'output_truncated', count: 2 }]);
  });
});

describe('the report is a fold of the journal', () => {
  it('is equal for the same journal, and for the journal read back from JSON', () => {
    const events = golden();
    const reread = JSON.parse(JSON.stringify(events)) as RunEvent[];
    expect(buildRunReport(events)).toEqual(buildRunReport(golden()));
    expect(buildRunReport(reread)).toEqual(buildRunReport(events));
  });

  it('depends only on the journal: every prefix folds without reading anything else', () => {
    const events = golden();
    for (let length = 1; length <= events.length; length += 1) {
      const prefix = events.slice(0, length);
      expect(buildRunReport(prefix)).toEqual(buildRunReport(JSON.parse(JSON.stringify(prefix)) as RunEvent[]));
    }
  });
});
