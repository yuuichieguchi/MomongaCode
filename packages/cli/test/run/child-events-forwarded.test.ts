import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import { asChildEvent } from '../../src/run/child-events.ts';

const eventOf = (fields: Record<string, unknown>): PublicRunEvent => fields as unknown as PublicRunEvent;

describe('a subagent child shows its held, waiting and check events', () => {
  it('a held call of the child carries the child qualifier on its call id', () => {
    const shown = asChildEvent(eventOf({ type: 'tool.held', runId: 'run-1', callId: 'c1', approvalId: 'a1', reason: 'needs approval', footprint: {} }), 'worker');
    expect(shown).toMatchObject({ type: 'tool.held', callId: 'run-1/c1' });
  });

  it('the resolution of a held call of the child carries the child qualifier on its call id', () => {
    const shown = asChildEvent(eventOf({ type: 'tool.held.resolved', runId: 'run-1', callId: 'c1', approvalId: 'a1', outcome: 'rejected', status: 'failed', output: '' }), 'worker');
    expect(shown).toMatchObject({ type: 'tool.held.resolved', callId: 'run-1/c1' });
  });

  it('a waiting tool of the child carries the child qualifier on its call id', () => {
    const shown = asChildEvent(eventOf({ type: 'tool.waiting', runId: 'run-1', callId: 'c1', awaits: { kind: 'timer' } }), 'worker');
    expect(shown).toMatchObject({ type: 'tool.waiting', callId: 'run-1/c1' });
  });

  it.each([
    ['verification.completed', { round: 1, conditionId: 'tests', command: 'npm test', outcome: 'passed', durationMs: 1, output: '' }],
    ['budget.exhausted', { dimension: 'steps', cause: 'limit', spent: 2, limit: 2 }],
    ['notice', { level: 'info', message: 'the child is done' }],
  ])('a %s event of the child is forwarded', (type, fields) => {
    const event = eventOf({ type, runId: 'run-1', ...fields });
    expect(asChildEvent(event, 'worker')).toBe(event);
  });
});

describe('a subagent child ignores session events', () => {
  it('drops memory.judged', () => {
    expect(asChildEvent(eventOf({ type: 'memory.judged', id: 3, sessionId: 'session-1', createdAt: 1, memoryId: 'mem-1' }), 'worker')).toBeUndefined();
  });
});
