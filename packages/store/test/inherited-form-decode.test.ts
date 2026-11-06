import { describe, expect, expectTypeOf, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { decodeRunEvents } from '../src/codec.ts';

const rowOf = (payload: Record<string, unknown>) => ({
  id: 1,
  run_id: 'run-next',
  session_id: 'session-1',
  seq: 2,
  step: 0,
  lease_token: 1,
  created_at: 0,
  type: 'context.inherited',
  payload_json: canonicalJson(payload),
});

const REFERENCE = {
  type: 'context.inherited',
  form: 'reference',
  fromRunId: 'run-source',
  fromLastSeq: 4,
  nextItemSeq: 3,
  fromNextItemSeq: 3,
  omitSeqs: [],
  synthesised: [],
  via: [],
  itemCount: 2,
  closures: [],
  markers: [],
  workingFacts: { itemEvents: [] },
  activatedSkills: [],
  digest: 'd',
};

const failureOf = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('the decoder checks the form of context.inherited (13.12, the type change, review F5)', () => {
  it('refuses a row with neither form nor history as previous_run_inconsistent', () => {
    const { form: _form, ...withoutForm } = REFERENCE;
    expect(failureOf(() => decodeRunEvents([rowOf(withoutForm)]))).toEqual(expect.objectContaining({ code: 'previous_run_inconsistent' }));
  });

  it('refuses a reference row that carries a history as previous_run_inconsistent', () => {
    expect(failureOf(() => decodeRunEvents([rowOf({ ...REFERENCE, history: [] })]))).toEqual(expect.objectContaining({ code: 'previous_run_inconsistent' }));
  });

  it('refuses a reference row without its reference fields as previous_run_inconsistent', () => {
    const { fromNextItemSeq: _next, ...missing } = REFERENCE;
    expect(failureOf(() => decodeRunEvents([rowOf(missing)]))).toEqual(expect.objectContaining({ code: 'previous_run_inconsistent' }));
  });

  it('the un-narrowed context.inherited payload has no history field, so every reader must choose a form', () => {
    expectTypeOf<'history' extends keyof Extract<RunEventPayload, { type: 'context.inherited' }> ? true : false>().toEqualTypeOf<false>();
  });
});
