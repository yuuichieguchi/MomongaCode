import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, INBOX_DELIVERIES, INBOX_STATES } from '@momonga/protocol';
import { MIGRATIONS } from '../../src/schema.ts';

const RECORDED = {
  migration: 49,
  eventTypes: [
    'agent.message.delta',
    'agent.thought.delta',
    'approval.rule.persisted',
    'attempt.failed',
    'attempt.lost',
    'budget.exhausted',
    'context.compacted',
    'context.compacting',
    'context.compaction_rejected',
    'context.contribution',
    'context.governing_loaded',
    'context.inherited',
    'context.inherited_compacted',
    'context.memories_loaded',
    'context.truncated',
    'hook.completed',
    'hook.started',
    'inbox.changed',
    'instructions.loaded',
    'job.finished',
    'loop.warned',
    'mcp.authorization.required',
    'meter.observed',
    'mode.changed',
    'model.changed',
    'model.rejected',
    'model.requested',
    'model.responded',
    'model.stream.restarted',
    'notice',
    'plan.updated',
    'run.quiescent',
    'run.started',
    'run.status',
    'skill.activated',
    'tool.call',
    'tool.completed',
    'tool.elicitation.cancelled',
    'tool.elicitation.requested',
    'tool.elicitation.resolved',
    'tool.held',
    'tool.held.resolved',
    'tool.loaded',
    'tool.offered',
    'tool.permission.cancelled',
    'tool.permission.classified',
    'tool.permission.classifying',
    'tool.permission.requested',
    'tool.permission.resolved',
    'tool.reconciled',
    'tool.started',
    'tool.unknown.cancelled',
    'tool.unknown.requested',
    'tool.unknown.resolved',
    'tool.updated',
    'tool.waiting',
    'usage.charged',
    'usage.updated',
    'user.compact',
    'user.message',
    'user_shell',
    'verification.completed',
    'verification.started',
  ],
  inboxDeliveries: ['steer', 'queue'],
  inboxStates: ['pending', 'delivered', 'withdrawn'],
};

const RULE = 'a build that writes a new event type or a new stored value also adds a migration, so that an older build reads the newer database with tolerance: add the migration, then record its number and the sets here';

describe('the stored closed sets are recorded with the migration that carries them', () => {
  it('writes no event type and no inbox value beyond those recorded with the newest recording migration', () => {
    expect({ eventTypes: [...EVENT_TYPES].sort(), inboxDeliveries: [...INBOX_DELIVERIES], inboxStates: [...INBOX_STATES] }, RULE).toEqual({
      eventTypes: RECORDED.eventTypes,
      inboxDeliveries: RECORDED.inboxDeliveries,
      inboxStates: RECORDED.inboxStates,
    });
  });

  it('has the migration the sets are recorded with, and its name says what it records', () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === RECORDED.migration);
    expect(migration?.name).toMatch(/context\.inherited_compacted/);
  });
});
