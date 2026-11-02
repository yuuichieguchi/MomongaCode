import { describe, expect, it } from 'vitest';
import { grade } from '@momonga/eval';
import type { GraderSpec } from '@momonga/eval';
import { approvalTranscript, finalAnswerTranscript, toolRoundTripTranscript } from './fixtures.ts';

const outcomeOf = (spec: GraderSpec, transcript = finalAnswerTranscript('c', 0)) => grade([spec], transcript).outcomes[0];

describe('programmatic graders', () => {
  it('grades the terminal status and the stop reason', () => {
    expect(outcomeOf({ kind: 'status', equals: 'COMPLETED' })?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'status', equals: 'FAILED' })?.kind).toBe('fail');
    expect(outcomeOf({ kind: 'noStopReason' })?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'stopReason', equals: 'max_steps' })?.kind).toBe('fail');
  });

  it('grades the final text from the last model response', () => {
    expect(outcomeOf({ kind: 'finalTextEquals', text: 'hi' })?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'finalTextEquals', text: 'h' })?.kind).toBe('fail');
    expect(outcomeOf({ kind: 'finalTextIncludes', text: 'h' })?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'finalTextMatches', pattern: '^h.$' })?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'finalTextMatches', pattern: '^x' })?.kind).toBe('fail');
  });

  it('grades tool calls by name, count and input subset', () => {
    const transcript = toolRoundTripTranscript('c', 0);
    expect(outcomeOf({ kind: 'toolCalled', name: 'Read' }, transcript)?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'toolCalled', name: 'Read', inputIncludes: { path: 'a.txt' } }, transcript)?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'toolCalled', name: 'Read', inputIncludes: { path: 'b.txt' } }, transcript)?.kind).toBe('fail');
    expect(outcomeOf({ kind: 'toolCalled', name: 'Read', count: { min: 2 } }, transcript)?.kind).toBe('fail');
    expect(outcomeOf({ kind: 'toolCalled', name: 'Write' }, transcript)?.kind).toBe('fail');
    expect(outcomeOf({ kind: 'toolNotCalled', name: 'Write' }, transcript)?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'toolNotCalled', name: 'Read' }, transcript)?.kind).toBe('fail');
  });

  it('grades the step and token budgets from the run record', () => {
    const transcript = toolRoundTripTranscript('c', 0);
    expect(outcomeOf({ kind: 'stepsAtMost', max: 2 }, transcript)?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'stepsAtMost', max: 1 }, transcript)?.kind).toBe('fail');
    expect(outcomeOf({ kind: 'tokensAtMost', max: 59 }, transcript)?.kind).toBe('pass');
    expect(outcomeOf({ kind: 'tokensAtMost', max: 58 }, transcript)?.kind).toBe('fail');
  });

  it('observes allow for a call that started without a request', () => {
    const graded = grade([{ kind: 'permissionDecision', tool: 'Read', expected: 'allow' }], toolRoundTripTranscript('c', 0));
    expect(graded.decisions).toEqual([{ tool: 'Read', expected: 'allow', observed: 'allow' }]);
    expect(graded.passed).toBe(true);
  });

  it('observes ask for a call that requested approval, even when it later started', () => {
    const graded = grade([{ kind: 'permissionDecision', tool: 'Bash', expected: 'ask' }], approvalTranscript('c', 0));
    expect(graded.decisions).toEqual([{ tool: 'Bash', expected: 'ask', observed: 'ask' }]);
    expect(graded.passed).toBe(true);
  });

  it('reports a decision that was never made as not_called and fails the run', () => {
    const graded = grade([{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }], finalAnswerTranscript('c', 0));
    expect(graded.decisions).toEqual([{ tool: 'Write', expected: 'ask', observed: 'not_called' }]);
    expect(graded.passed).toBe(false);
  });

  it('observes deny only from the structured denial of a call that never started', () => {
    const transcript = toolRoundTripTranscript('c', 0);
    const events = transcript.events.filter((event) => event.type !== 'tool.started').map((event) =>
      event.type === 'tool.completed'
        ? { ...event, status: 'failed' as const, output: 'Permission denied: /w/a.txt is blocked', denial: { source: 'sandbox' as const, reason: '/w/a.txt is blocked' } }
        : event,
    );
    const denied = grade([{ kind: 'permissionDecision', tool: 'Read', expected: 'deny' }], { ...transcript, events });
    expect(denied.decisions[0]?.observed).toBe('deny');
    const otherFailure = events.map((event) => {
      if (event.type !== 'tool.completed') return event;
      const { denial: _denial, ...rest } = event;
      return { ...rest, output: 'Permission denied: looks like a denial but carries no signal' };
    });
    const unresolved = grade([{ kind: 'permissionDecision', tool: 'Read', expected: 'deny' }], { ...transcript, events: otherFailure });
    expect(unresolved.decisions[0]?.observed).toBe('unresolved');
  });

  it('passes a run only when every grader passes', () => {
    const graded = grade([{ kind: 'status', equals: 'COMPLETED' }, { kind: 'finalTextEquals', text: 'nope' }], finalAnswerTranscript('c', 0));
    expect(graded.outcomes.map((outcome) => outcome.kind)).toEqual(['pass', 'fail']);
    expect(graded.passed).toBe(false);
  });
});
