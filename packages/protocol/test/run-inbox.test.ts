import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, INBOX_DELIVERIES, INBOX_MAX_PENDING, INBOX_STATES, INBOX_WITHDRAW_OUTCOMES, RUN_API_SCHEMAS, inboxFullMessage, toPublicRunEvent } from '@momonga/protocol';
import type { InboxRowView, RunEvent, SessionEvent } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);

const accepts = (name: keyof typeof RUN_API_SCHEMAS, value: unknown): boolean => ajv.compile(RUN_API_SCHEMAS[name])(value) === true;

const row = (overrides: Partial<InboxRowView> = {}): InboxRowView => ({
  id: 'row-1',
  sessionId: 'sess-1',
  delivery: 'queue',
  text: 'next task',
  seq: 1,
  state: 'pending',
  createdAt: 1_800_000_000_000,
  settledAt: null,
  ...overrides,
});

const RUN = {
  id: 'run-2',
  sessionId: 'sess-1',
  ordinal: 2,
  status: 'QUEUED',
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  step: 0,
  limits: {},
  createdAt: 1,
  deadlineAt: 2,
  cancelRequested: false,
  lastSeq: 1,
  previousRunId: 'run-1',
  history: 'inherit',
  parentRunId: null,
  parentCallId: null,
  origin: 'trusted',
};

describe('the run inbox contract (design 5.3)', () => {
  it('names the two deliveries, the three states, the two withdraw answers and the bound of 20', () => {
    expect(INBOX_DELIVERIES).toEqual(['steer', 'queue']);
    expect(INBOX_STATES).toEqual(['pending', 'delivered', 'withdrawn']);
    expect(INBOX_WITHDRAW_OUTCOMES).toEqual(['withdrawn', 'already_delivered']);
    expect(INBOX_MAX_PENDING).toBe(20);
    expect(inboxFullMessage()).toBe('20 messages are already waiting');
  });

  it('validates the add request: a delivery, a text limited like a prompt, and images of the prompt shape', () => {
    expect(accepts('AddInboxRequest', { delivery: 'queue', text: 'x' })).toBe(true);
    expect(accepts('AddInboxRequest', { delivery: 'steer', text: 'x', images: [{ mediaType: 'image/png', data: 'AAAA' }] })).toBe(true);
    expect(accepts('AddInboxRequest', { delivery: 'interrupt', text: 'x' })).toBe(false);
    expect(accepts('AddInboxRequest', { delivery: 'queue', text: '' })).toBe(false);
    expect(accepts('AddInboxRequest', { delivery: 'queue', text: 'a'.repeat(1_000_001) })).toBe(false);
    expect(accepts('AddInboxRequest', { delivery: 'queue' })).toBe(false);
    expect(accepts('AddInboxRequest', { text: 'x' })).toBe(false);
    expect(accepts('AddInboxRequest', { delivery: 'queue', text: 'x', sessionId: 's' })).toBe(false);
  });

  it('validates a row and the three answers', () => {
    expect(accepts('InboxRowView', row())).toBe(true);
    expect(accepts('InboxRowView', row({ state: 'delivered', settledAt: 5, images: [{ mediaType: 'image/png', byteLength: 3 }] }))).toBe(true);
    expect(accepts('InboxRowView', { ...row(), state: 'lost' })).toBe(false);
    expect(accepts('InboxRowView', { ...row(), seq: 0 })).toBe(false);
    expect(accepts('InboxResponse', { pending: [row(), row({ id: 'row-2', seq: 2, delivery: 'steer' })] })).toBe(true);
    expect(accepts('InboxResponse', { pending: Array.from({ length: INBOX_MAX_PENDING + 1 }, (_, index) => row({ id: `row-${index}`, seq: index + 1 })) })).toBe(false);
    expect(accepts('InboxAddResponse', { row: row(), pending: [row()] })).toBe(true);
    expect(accepts('InboxAddResponse', { pending: [] })).toBe(false);
    expect(accepts('InboxWithdrawResponse', { outcome: 'withdrawn', row: row({ state: 'withdrawn', settledAt: 9 }), pending: [] })).toBe(true);
    expect(accepts('InboxWithdrawResponse', { outcome: 'already_delivered', row: row({ state: 'delivered', settledAt: 9 }), pending: [] })).toBe(true);
    expect(accepts('InboxWithdrawResponse', { outcome: 'gone', row: row(), pending: [] })).toBe(false);
    expect(accepts('RunSuccessorResponse', { successor: null })).toBe(true);
    expect(accepts('RunSuccessorResponse', { successor: RUN })).toBe(true);
    expect(accepts('RunSuccessorResponse', {})).toBe(false);
  });

  it('has the session event inbox.changed with the rows pending after the change', () => {
    expect(EVENT_TYPES).toContain('inbox.changed');
    const event: SessionEvent = { type: 'inbox.changed', pending: [row()], id: 4, sessionId: 'sess-1', createdAt: 1 };
    expect(accepts('PublicRunEvent', event)).toBe(true);
    expect(toPublicRunEvent(event)).toEqual(event);
    expect(accepts('PublicRunEvent', { type: 'inbox.changed', id: 4, sessionId: 'sess-1', createdAt: 1 })).toBe(false);
    expect(accepts('PublicRunEvent', { ...event, runId: 'run-1' })).toBe(false);
  });

  it('marks a user message that came from the inbox with its source, and keeps the mark in the public event', () => {
    const envelope = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 1, createdAt: 1 };
    for (const source of INBOX_DELIVERIES) {
      const stored: RunEvent = { ...envelope, leaseToken: 1, type: 'user.message', text: 'also the tests', source };
      expect(toPublicRunEvent(stored)).toEqual({ ...envelope, type: 'user.message', text: 'also the tests', source });
      expect(accepts('PublicRunEvent', { ...envelope, type: 'user.message', text: 'also the tests', source })).toBe(true);
    }
    expect(accepts('PublicRunEvent', { ...envelope, type: 'user.message', text: 'x', source: 'hook' })).toBe(false);
    expect(toPublicRunEvent({ ...envelope, leaseToken: 1, type: 'user.message', text: 'typed' })).toEqual({ ...envelope, type: 'user.message', text: 'typed' });
  });
});
