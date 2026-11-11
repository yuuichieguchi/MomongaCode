import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT_RETENTION_DAYS } from '@momonga/config';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const DAY_MS = 86_400_000;
const MIN_RETENTION_DAYS = 1n;
const MAX_RETENTION_DAYS = 36_500n;
const MAX_SAFE = 2n ** 53n - 1n;
const MAX_TIMESTAMP_MS = 2n ** 52n;

const satisfiable = async (arith: ProofArith): Promise<boolean> => {
  const solver = new arith.ctx.Solver();
  solver.add(...arith.assertions());
  return (await solver.check()) === 'sat';
};

const withinRange = (arith: ProofArith, value: ProofInt, upper: bigint) => arith.ctx.And(value.ge(0), value.le(arith.ctx.Int.val(upper)));

const timestamp = (arith: ProofArith, name: string): ProofInt => {
  const value = arith.int(name);
  arith.given(withinRange(arith, value, MAX_TIMESTAMP_MS));
  return value;
};

const retentionDays = (arith: ProofArith, name: string): ProofInt => {
  const value = arith.int(name);
  arith.given(value.ge(arith.ctx.Int.val(MIN_RETENTION_DAYS)), value.le(arith.ctx.Int.val(MAX_RETENTION_DAYS)));
  return value;
};

const windowOf = (arith: ProofArith, days: ProofInt): ProofInt => days.mul(arith.ctx.Int.val(BigInt(DAY_MS)));

const expiredAt = (arith: ProofArith, lastActivity: ProofInt, days: ProofInt, now: ProofInt) => lastActivity.add(windowOf(arith, days)).le(now);

describe('Q16: the day arithmetic of the retention period', () => {
  const z3 = useZ3();

  it('reads today the constants the proofs start from', () => {
    expect(DAY_MS).toBe(86_400_000);
    expect(MIN_RETENTION_DAYS).toBe(1n);
    expect(MAX_RETENTION_DAYS).toBe(36_500n);
    expect(MAX_TIMESTAMP_MS).toBeLessThan(MAX_SAFE);
    expect(DEFAULT_CONTENT_RETENTION_DAYS).toBe(30);
    expect(BigInt(DEFAULT_CONTENT_RETENTION_DAYS)).toBeGreaterThanOrEqual(MIN_RETENTION_DAYS);
    expect(BigInt(DEFAULT_CONTENT_RETENTION_DAYS)).toBeLessThanOrEqual(MAX_RETENTION_DAYS);
  });

  it(
    'D1 proves lastActivity + days * 86 400 000 stays a safe integer for every days in [1, 36 500] and every lastActivity in [0, 2^52]',
    async () => {
      const arith = proofArith(z3.engine().api, 'D1');
      const last = timestamp(arith, 'lastActivity');
      const days = retentionDays(arith, 'days');
      expect(await satisfiable(arith)).toBe(true);
      const expiry = last.add(windowOf(arith, days));
      expect(await prove(arith, arith.ctx.And(expiry.ge(0), expiry.le(arith.ctx.Int.val(MAX_SAFE))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D1w refutes the same bound when days has no maximum, so the maximum of 36 500 is what keeps the sum a safe integer',
    async () => {
      const arith = proofArith(z3.engine().api, 'D1w');
      const last = timestamp(arith, 'lastActivity');
      const days = arith.int('days');
      arith.given(days.ge(arith.ctx.Int.val(MIN_RETENTION_DAYS)));
      const expiry = last.add(windowOf(arith, days));
      const model = await expectRefuted(arith, expiry.le(arith.ctx.Int.val(MAX_SAFE)));
      expect(BigInt(model['days'] as string)).toBeGreaterThan(MAX_RETENTION_DAYS);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D2 proves the two forms of the test, lastActivity + window <= now and now - lastActivity >= window, agree and that both operands stay safe integers',
    async () => {
      const arith = proofArith(z3.engine().api, 'D2');
      const last = timestamp(arith, 'lastActivity');
      const now = timestamp(arith, 'now');
      const days = retentionDays(arith, 'days');
      expect(await satisfiable(arith)).toBe(true);
      const window = windowOf(arith, days);
      const { ctx } = arith;
      const agree = expiredAt(arith, last, days, now).eq(now.sub(last).ge(window));
      const operands = ctx.And(now.sub(last).ge(ctx.Int.val(-MAX_SAFE)), now.sub(last).le(ctx.Int.val(MAX_SAFE)));
      expect(await prove(arith, ctx.And(agree, operands))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D3 proves a session is never expired before lastActivity + window, and is expired from that instant on, for every now',
    async () => {
      const arith = proofArith(z3.engine().api, 'D3');
      const last = timestamp(arith, 'lastActivity');
      const now = timestamp(arith, 'now');
      const days = retentionDays(arith, 'days');
      expect(await satisfiable(arith)).toBe(true);
      const { ctx } = arith;
      const edge = last.add(windowOf(arith, days));
      const goal = ctx.And(ctx.Implies(now.lt(edge), ctx.Not(expiredAt(arith, last, days, now))), ctx.Implies(now.ge(edge), expiredAt(arith, last, days, now)));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D4 proves expiry is monotone: later now, older lastActivity and shorter period each keep an expired session expired',
    async () => {
      const arith = proofArith(z3.engine().api, 'D4');
      const lastOlder = timestamp(arith, 'lastOlder');
      const lastNewer = timestamp(arith, 'lastNewer');
      const nowEarlier = timestamp(arith, 'nowEarlier');
      const nowLater = timestamp(arith, 'nowLater');
      const daysShorter = retentionDays(arith, 'daysShorter');
      const daysLonger = retentionDays(arith, 'daysLonger');
      arith.given(lastOlder.le(lastNewer), nowEarlier.le(nowLater), daysShorter.le(daysLonger));
      expect(await satisfiable(arith)).toBe(true);
      const { ctx } = arith;
      const goal = ctx.And(
        ctx.Implies(expiredAt(arith, lastNewer, daysLonger, nowEarlier), expiredAt(arith, lastOlder, daysLonger, nowEarlier)),
        ctx.Implies(expiredAt(arith, lastNewer, daysLonger, nowEarlier), expiredAt(arith, lastNewer, daysLonger, nowLater)),
        ctx.Implies(expiredAt(arith, lastNewer, daysLonger, nowEarlier), expiredAt(arith, lastNewer, daysShorter, nowEarlier)),
      );
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D5 proves a closure of three sessions is expired exactly when its newest lastActivity is expired, so one newer member keeps every member',
    async () => {
      const arith = proofArith(z3.engine().api, 'D5');
      const first = timestamp(arith, 'first');
      const second = timestamp(arith, 'second');
      const third = timestamp(arith, 'third');
      const now = timestamp(arith, 'now');
      const days = retentionDays(arith, 'days');
      expect(await satisfiable(arith)).toBe(true);
      const { ctx } = arith;
      const newest = arith.max(arith.max(first, second), third);
      const every = ctx.And(expiredAt(arith, first, days, now), expiredAt(arith, second, days, now), expiredAt(arith, third, days, now));
      expect(await prove(arith, every.eq(expiredAt(arith, newest, days, now)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D6 proves a clock that reads earlier than lastActivity expires nothing, for every days in [1, 36 500]',
    async () => {
      const arith = proofArith(z3.engine().api, 'D6');
      const last = timestamp(arith, 'lastActivity');
      const now = timestamp(arith, 'now');
      const days = retentionDays(arith, 'days');
      arith.given(now.lt(last));
      expect(await satisfiable(arith)).toBe(true);
      expect(await prove(arith, arith.ctx.Not(expiredAt(arith, last, days, now)))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D7 proves a clock behind the true time by any amount never expires a session early, and a clock ahead by d expires it at most d ms early',
    async () => {
      const arith = proofArith(z3.engine().api, 'D7');
      const last = timestamp(arith, 'lastActivity');
      const trueNow = timestamp(arith, 'trueNow');
      const offset = arith.int('offset');
      const days = retentionDays(arith, 'days');
      arith.given(offset.ge(0), offset.le(arith.ctx.Int.val(MAX_TIMESTAMP_MS)));
      expect(await satisfiable(arith)).toBe(true);
      const { ctx } = arith;
      const behind = ctx.Implies(expiredAt(arith, last, days, trueNow.sub(offset)), expiredAt(arith, last, days, trueNow));
      const ahead = ctx.Implies(expiredAt(arith, last, days, trueNow.add(offset)), trueNow.ge(last.add(windowOf(arith, days)).sub(offset)));
      expect(await prove(arith, ctx.And(behind, ahead))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D7w refutes that a clock ahead of the true time never expires a session early',
    async () => {
      const arith = proofArith(z3.engine().api, 'D7w');
      const last = timestamp(arith, 'lastActivity');
      const trueNow = timestamp(arith, 'trueNow');
      const offset = arith.int('offset');
      const days = retentionDays(arith, 'days');
      arith.given(offset.ge(1), offset.le(arith.ctx.Int.val(MAX_TIMESTAMP_MS)));
      const model = await expectRefuted(arith, arith.ctx.Implies(expiredAt(arith, last, days, trueNow.add(offset)), expiredAt(arith, last, days, trueNow)));
      expect(BigInt(model['offset'] as string)).toBeGreaterThanOrEqual(1n);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D8 proves the migration of a positive contentRetentionDays, clamped to [1, 36 500], keeps every value in range and changes none that is in range',
    async () => {
      const arith = proofArith(z3.engine().api, 'D8');
      const legacy = arith.int('contentRetentionDays');
      arith.given(legacy.ge(1));
      expect(await satisfiable(arith)).toBe(true);
      const { ctx } = arith;
      const clamped = arith.min(legacy, ctx.Int.val(MAX_RETENTION_DAYS));
      const goal = ctx.And(clamped.ge(ctx.Int.val(MIN_RETENTION_DAYS)), clamped.le(ctx.Int.val(MAX_RETENTION_DAYS)), ctx.Implies(legacy.le(ctx.Int.val(MAX_RETENTION_DAYS)), clamped.eq(legacy)));
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'D8w refutes that an unclamped positive contentRetentionDays stays within [1, 36 500]',
    async () => {
      const arith = proofArith(z3.engine().api, 'D8w');
      const legacy = arith.int('contentRetentionDays');
      arith.given(legacy.ge(1));
      const model = await expectRefuted(arith, legacy.le(arith.ctx.Int.val(MAX_RETENTION_DAYS)));
      expect(BigInt(model['contentRetentionDays'] as string)).toBeGreaterThan(MAX_RETENTION_DAYS);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );
});
