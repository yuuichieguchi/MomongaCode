import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { RUN_API_SCHEMAS, UNKNOWN_VALUE } from '@momonga/protocol';
import type { InboxDelivery, InboxRowView, InboxState } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);

const accepts = (name: keyof typeof RUN_API_SCHEMAS, value: unknown): boolean => ajv.compile(RUN_API_SCHEMAS[name])(value) === true;

const modeChanged = (mode: string) => ({ type: 'mode.changed', id: 7, sessionId: 'sess-1', createdAt: 1_800_000_000_000, mode });

const inboxRow = (overrides: Record<string, unknown>) => ({ id: 'row-1', sessionId: 'sess-1', delivery: 'queue', text: 'next', seq: 1, state: 'pending', createdAt: 1_800_000_000_000, settledAt: null, ...overrides });

describe('a public field whose writer yields a stored closed set admits the value of a newer build', () => {
  it('admits mode.changed with the mode this build does not know, and no other foreign mode', () => {
    expect(accepts('PublicRunEvent', modeChanged('manual'))).toBe(true);
    expect(accepts('PublicRunEvent', modeChanged(UNKNOWN_VALUE))).toBe(true);
    expect(accepts('PublicRunEvent', modeChanged('from-a-newer-build'))).toBe(false);
  });

  it('admits an inbox row whose delivery or state this build does not know', () => {
    expect(accepts('InboxRowView', inboxRow({ delivery: UNKNOWN_VALUE }))).toBe(true);
    expect(accepts('InboxRowView', inboxRow({ state: UNKNOWN_VALUE, settledAt: 5 }))).toBe(true);
    expect(accepts('InboxRowView', inboxRow({ state: 'from-a-newer-build' }))).toBe(false);
    expectTypeOf<InboxRowView['delivery']>().toEqualTypeOf<InboxDelivery | typeof UNKNOWN_VALUE>();
    expectTypeOf<InboxRowView['state']>().toEqualTypeOf<InboxState | typeof UNKNOWN_VALUE>();
  });

  it('admits a trust view whose decision this build does not know', () => {
    expect(accepts('TrustView', { path: '/work/a', decision: UNKNOWN_VALUE })).toBe(true);
    expect(accepts('TrustView', { path: '/work/a', decision: 'from-a-newer-build' })).toBe(false);
  });

  it('still refuses the unknown value in a request', () => {
    expect(accepts('AddInboxRequest', { delivery: UNKNOWN_VALUE, text: 'x' })).toBe(false);
    expect(accepts('PutTrustRequest', { path: '/work/a', decision: UNKNOWN_VALUE })).toBe(false);
  });
});
