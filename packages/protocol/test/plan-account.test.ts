import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { PLAN_LABEL_PATTERN, RUN_API_SCHEMAS, isPlanLabel, planAccountRefOf } from '../src/index.ts';
import type { ChainMemberEntry, ErrorBody, NamedPlanAccountRef, PlanAccountRef, PlanActiveRequest, PlanSignOutRequest, ResponseError } from '../src/index.ts';

const LONGEST_LABEL = `a${'b'.repeat(127)}`;

describe('the plan label rule is defined with the plan account reference', () => {
  it('isPlanLabel accepts a label of the pattern and refuses every other value', () => {
    expect(['work', 'chatgpt', 'a.b_c-9', LONGEST_LABEL].map((value) => isPlanLabel(value))).toEqual([true, true, true, true]);
    expect(['', '.work', 'wo rk', 'work\n', 'chat/gpt', `${LONGEST_LABEL}b`, 'アカウント', 7, undefined, null].map((value) => isPlanLabel(value))).toEqual(new Array(10).fill(false));
  });

  it('PLAN_LABEL_PATTERN is the pattern isPlanLabel tests', () => {
    expect(new RegExp(PLAN_LABEL_PATTERN).test('work')).toBe(true);
    expect(new RegExp(PLAN_LABEL_PATTERN).test('wo rk')).toBe(false);
  });
});

describe('planAccountRefOf reads a plan account reference from untrusted input', () => {
  it('returns profile and account, and no other key, from a record that holds more', () => {
    const ref = planAccountRefOf({ profile: 'chatgpt', account: 'work', x: 1 });
    expect(ref).toEqual({ profile: 'chatgpt', account: 'work' });
    expect(Object.keys(ref ?? {})).toEqual(['profile', 'account']);
  });

  it('accepts the profile-only form of a target that serves the active account while none is active', () => {
    const ref = planAccountRefOf({ profile: 'chatgpt' });
    expect(ref).toEqual({ profile: 'chatgpt' });
    expect(Object.keys(ref ?? {})).toEqual(['profile']);
    expect(planAccountRefOf({ profile: 'chatgpt', account: undefined, x: 1 })).toEqual({ profile: 'chatgpt' });
  });

  it('is undefined for a non-record, a missing profile and a non-string member', () => {
    expect([null, [], 'chatgpt', { account: 'work' }, { profile: 7, account: 'work' }, { profile: 'a', account: 1 }, { profile: 'a', account: null }].map((value) => planAccountRefOf(value))).toEqual(
      new Array(7).fill(undefined),
    );
  });

  it('is undefined when the profile or a present account does not match the label pattern', () => {
    const refused = [
      { profile: 'chat/gpt', account: 'work' },
      { profile: 'chat/gpt' },
      { profile: 'chatgpt', account: 'wo rk' },
      { profile: 'chatgpt', account: 'work\nmore' },
      { profile: 'chatgpt', account: 'q'.repeat(129) },
      { profile: 'chatgpt', account: '' },
    ];
    expect(refused.map((value) => planAccountRefOf(value))).toEqual(new Array(refused.length).fill(undefined));
  });

  it('reads only own members: a profile inherited from a prototype is no profile', () => {
    expect(planAccountRefOf(Object.create({ profile: 'chatgpt', account: 'work' }))).toBeUndefined();
    expect(planAccountRefOf(Object.assign(Object.create({ account: 'work' }), { profile: 'chatgpt' }))).toEqual({ profile: 'chatgpt' });
  });
});

describe('one plan account reference type serves every surface', () => {
  it('the reference has a profile and an optional account; the named form requires the account', () => {
    expectTypeOf<PlanAccountRef>().toEqualTypeOf<{ profile: string; account?: string }>();
    expectTypeOf<NamedPlanAccountRef>().toEqualTypeOf<PlanAccountRef & { account: string }>();
  });

  it('errors, the model listing and the plan requests use it', () => {
    expectTypeOf<ErrorBody['plan']>().toEqualTypeOf<PlanAccountRef | undefined>();
    expectTypeOf<ResponseError['plan']>().toEqualTypeOf<PlanAccountRef | undefined>();
    expectTypeOf<ChainMemberEntry['plan']>().toEqualTypeOf<PlanAccountRef | undefined>();
    expectTypeOf<PlanActiveRequest>().toEqualTypeOf<NamedPlanAccountRef>();
    expectTypeOf<PlanSignOutRequest>().toEqualTypeOf<NamedPlanAccountRef>();
  });
});

describe('the Run API schema of a run error carries the one plan reference', () => {
  const ajv = new Ajv2020.default({ strict: false });
  const schema = RUN_API_SCHEMAS.RunView as unknown as { properties: { error: Record<string, unknown> } };
  const acceptsError = ajv.compile(schema.properties.error);
  const errorWith = (plan: unknown): unknown => ({ code: 'sign_in_required', message: 'm', plan });

  it('accepts a profile with an account and the profile-only form', () => {
    expect(acceptsError(errorWith({ profile: 'chatgpt', account: 'work' }))).toBe(true);
    expect(acceptsError(errorWith({ profile: 'chatgpt' }))).toBe(true);
  });

  it('refuses a plan with no profile, with another key, or with a label outside the pattern', () => {
    expect([{ account: 'work' }, { profile: 'chatgpt', account: 'work', x: 1 }, { profile: 'chat/gpt' }, { profile: 'chatgpt', account: 'wo rk' }].map((plan) => acceptsError(errorWith(plan)))).toEqual([false, false, false, false]);
  });
});
