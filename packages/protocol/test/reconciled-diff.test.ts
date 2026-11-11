import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { RUN_API_SCHEMAS, toPublicRunEvent } from '@momonga/protocol';
import type { DiffHunk, InboxChangeRow, RunEvent, RunEventPayload, SessionEvent } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);

const accepts = (value: unknown): boolean => ajv.compile(RUN_API_SCHEMAS.PublicRunEvent)(value) === true;

const ENVELOPE = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 1, createdAt: 1 };

const HUNKS: DiffHunk[] = [{ oldStart: 1, newStart: 1, lines: [' keep', '-old', '+new'] }];

describe('the change of an edit on its events', () => {
  it('lets a reconciled event carry the diff fields of the call it settles', () => {
    const event: RunEvent = {
      ...ENVELOPE,
      leaseToken: 1,
      type: 'tool.reconciled',
      callId: 'c1',
      outcome: 'already_applied',
      output: 'Edit to a.txt had already been applied',
      files: [{ path: '/work/a.txt', sha256: 'f'.repeat(64), access: 'write' }],
      hunks: HUNKS,
      added: 1,
      removed: 1,
    };
    const shown = toPublicRunEvent(event);
    expect(shown).toMatchObject({ hunks: HUNKS, added: 1, removed: 1 });
    expect(accepts(shown)).toBe(true);
    expect(accepts({ ...shown, hunks: undefined, added: undefined, removed: undefined, diffOmitted: 'file larger than 256 KiB' })).toBe(true);
    expect(accepts({ ...shown, hunks: [{ oldStart: 1, lines: [] }] })).toBe(false);
  });

  it('types the diff fields of tool.reconciled as those of tool.completed', () => {
    type DiffFields = 'hunks' | 'added' | 'removed' | 'diffOmitted';
    type Completed = Extract<RunEventPayload, { type: 'tool.completed' }>;
    type Reconciled = Extract<RunEventPayload, { type: 'tool.reconciled' }>;
    expectTypeOf<Pick<Reconciled, DiffFields>>().toEqualTypeOf<Pick<Completed, DiffFields>>();
  });
});

describe('the rows of inbox.changed', () => {
  const event: SessionEvent = { type: 'inbox.changed', pending: [{ id: 'row-1', delivery: 'queue', state: 'pending', seq: 1 }], id: 4, sessionId: 'sess-1', createdAt: 1 };

  it('are id, delivery, state and seq', () => {
    expectTypeOf<Extract<SessionEvent, { type: 'inbox.changed' }>['pending']>().toEqualTypeOf<InboxChangeRow[]>();
    expectTypeOf<InboxChangeRow>().toEqualTypeOf<{ id: string; delivery: 'steer' | 'queue' | 'unknown'; state: 'pending' | 'delivered' | 'withdrawn' | 'unknown'; seq: number }>();
    expect(accepts(toPublicRunEvent(event))).toBe(true);
  });

  it('refuse a row that carries the text of the message', () => {
    expect(accepts({ ...event, pending: [{ id: 'row-1', delivery: 'queue', state: 'pending', seq: 1, text: 'next' }] })).toBe(false);
    expect(accepts({ ...event, pending: [{ id: 'row-1', sessionId: 'sess-1', delivery: 'queue', text: 'next', seq: 1, state: 'pending', createdAt: 1, settledAt: null }] })).toBe(false);
  });
});
