import { describe, expect, it, vi } from 'vitest';
import * as config from '@momonga/config';
import { MARGIN, MIN_MARGIN, OUTPUT_RESERVE } from '@momonga/protocol';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { seeded } from '../../context/test/helpers.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

type Member = { model: string; facts: { outputBounded: boolean; contextWindow: number; maxOutputTokens: number }; measuring: boolean };
type Verdict = { kind: 'serve' } | { kind: 'wait' } | { kind: 'refuse'; refusal: Record<string, unknown> };

const chainRoomVerdict = (first: string, members: readonly Member[]): Verdict => {
  const value = (config as Record<string, unknown>)['chainRoomVerdict'];
  if (typeof value !== 'function') throw new Error('@momonga/config does not export chainRoomVerdict (packages/config/src/chain-room.ts)');
  return (value as (first: string, members: readonly Member[]) => Verdict)(first, members);
};

const CHAINS = 300;
const MAX_WINDOW = 2 ** 33;

const ceilOf = (ratio: { num: number; den: number }, value: number): number => Number((BigInt(value) * BigInt(ratio.num) + BigInt(ratio.den) - 1n) / BigInt(ratio.den));

const foldOf = (members: readonly Member[]) => {
  const minWindow = Math.min(...members.map((member) => member.facts.contextWindow));
  const unboundedOutputTokens = Math.max(...members.map((member) => member.facts.maxOutputTokens));
  const margin = Math.max(ceilOf(MARGIN, minWindow), MIN_MARGIN);
  const required = ceilOf(OUTPUT_RESERVE, minWindow);
  const room = minWindow - unboundedOutputTokens - margin;
  return { unboundedOutputTokens, minWindow, margin, room, required };
};

const memberOf = (index: number, contextWindow: number, maxOutputTokens: number, outputBounded: boolean): Member => ({ model: `srv-host-${index}/m`, facts: { outputBounded, contextWindow, maxOutputTokens }, measuring: false });

const windowOf = (random: ReturnType<typeof seeded>): number => (random.int(0, 2) === 0 ? random.int(1, 4096) : Math.max(1, Math.floor(random.next() * MAX_WINDOW)));

const chainOf = (seed: number): Member[] => {
  const random = seeded(seed);
  const length = random.int(1, 8);
  const unbounded = random.int(0, length - 1);
  return Array.from({ length }, (_unused, index) => {
    const contextWindow = windowOf(random);
    return memberOf(index, contextWindow, random.int(1, contextWindow), index !== unbounded);
  });
};

describe('chainRoomVerdict is the fold of the chain', () => {
  it(
    'for 300 generated chains of 1 to 8 members with one unbounded member, the verdict is the fold of the smallest window and the largest output',
    () => {
      for (let seed = 1; seed <= CHAINS; seed += 1) {
        const members = chainOf(seed);
        const first = (members[0] as Member).model;
        const fold = foldOf(members);
        const expected: Verdict = fold.room < fold.required ? { kind: 'refuse', refusal: { kind: 'small_room', first, ...fold } } : { kind: 'serve' };
        expect(chainRoomVerdict(first, members), `seed ${seed}`).toEqual(expected);
      }
    },
  );

  it('a longer chain is not always harder to serve: a member with a smaller window turns a refusal into a serve', () => {
    const alone = [memberOf(0, 1701, 1241, false)];
    const longer = [...alone, memberOf(1, 1700, 1, true)];
    expect(foldOf(alone)).toEqual({ unboundedOutputTokens: 1241, minWindow: 1701, margin: 35, room: 425, required: 426 });
    expect(foldOf(longer)).toEqual({ unboundedOutputTokens: 1241, minWindow: 1700, margin: 34, room: 425, required: 425 });
    expect(chainRoomVerdict('srv-host-0/m', alone)).toEqual({ kind: 'refuse', refusal: { kind: 'small_room', first: 'srv-host-0/m', unboundedOutputTokens: 1241, minWindow: 1701, margin: 35, room: 425, required: 426 } });
    expect(chainRoomVerdict('srv-host-0/m', longer)).toEqual({ kind: 'serve' });
  });
});
