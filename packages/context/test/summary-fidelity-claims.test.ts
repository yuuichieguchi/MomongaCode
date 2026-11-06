import { describe, expect, it } from 'vitest';
import { attestedTokens, checkSummary, claimedTokens } from '@momonga/context';
import type { FidelityRecord, FidelitySource } from '@momonga/context';

const CWD = '/proj';

const record = (overrides: Partial<FidelityRecord> = {}): FidelityRecord => ({ executedLeaves: [], executedText: [], statedText: [], ...overrides });

const fabricatedIn = (summary: string, from: FidelityRecord): string[] =>
  checkSummary(summary, { attested: attestedTokens(claimedTokens(summary), from, CWD), pinned: '', critical: [], workingState: '' }).fabricated;

const USER_ONLY = record({ statedText: ['please run `make deploy` when you are done'] });

describe('claims by section', () => {
  it('gives STATE and DONE tokens the executed claim and GOAL, DECISIONS, GUARDRAILS the any claim', () => {
    const summary = 'GOAL:\n`g1`\nSTATE:\n`s1`\nDONE:\n`d1`\nDECISIONS:\n`x1`\nGUARDRAILS:\n`y1`';
    expect(claimedTokens(summary)).toEqual([
      { token: 'g1', claim: 'any' },
      { token: 's1', claim: 'executed' },
      { token: 'd1', claim: 'executed' },
      { token: 'x1', claim: 'any' },
      { token: 'y1', claim: 'any' },
    ]);
  });

  it('claims nothing for a token only in TODO', () => {
    expect(claimedTokens('TODO:\ncreate `src/new.ts`')).toEqual([]);
  });

  it('gives a token in two sections the stricter claim', () => {
    expect(claimedTokens('GOAL:\n`make deploy`\nDONE:\n`make deploy`')).toEqual([{ token: 'make deploy', claim: 'executed' }]);
  });

  it('marks a command in DONE that the user only mentioned as fabricated', () => {
    expect(fabricatedIn('DONE:\nran `make deploy`', USER_ONLY)).toEqual(['make deploy']);
  });

  it('accepts the same command in GOAL', () => {
    expect(fabricatedIn('GOAL:\nthe user wants `make deploy`', USER_ONLY)).toEqual([]);
  });

  it('accepts the command in DONE once a call that ran holds it', () => {
    expect(fabricatedIn('DONE:\nran `make deploy`', record({ executedLeaves: ['make deploy'] }))).toEqual([]);
  });
});

describe('the previous summary attests nothing', () => {
  it('marks a token exempted in TODO and repeated in the next DONE as fabricated', () => {
    const previous = 'GOAL:\ng\nTODO:\ncreate `src/new.ts`';
    expect(checkSummary(previous, { attested: [], pinned: '', critical: [], workingState: '' }).fabricated).toEqual([]);
    const next = 'GOAL:\ng\nDONE:\ncreated `src/new.ts`';
    const laundering = { attested: attestedTokens(claimedTokens(next), record(), CWD), pinned: '', critical: [], workingState: '', previousSummary: previous } as FidelitySource;
    expect(checkSummary(next, laundering).fabricated).toEqual(['src/new.ts']);
  });
});

describe('paths compared after stripping the working directory', () => {
  it('matches an absolute path under the session cwd against a relative record', () => {
    expect(attestedTokens([{ token: '/proj/lib/b.ts', claim: 'executed' }], record({ executedLeaves: ['lib/b.ts'] }), CWD)).toEqual(['/proj/lib/b.ts']);
  });

  it('does not match /other/lib/b.ts against a record that holds lib/b.ts', () => {
    expect(attestedTokens([{ token: '/other/lib/b.ts', claim: 'executed' }], record({ executedLeaves: ['lib/b.ts'] }), CWD)).toEqual([]);
  });

  it('does not match a/b.ts inside xa/b.ts in recorded text', () => {
    expect(attestedTokens([{ token: 'a/b.ts', claim: 'executed' }], record({ executedText: ['wrote xa/b.ts'] }), CWD)).toEqual([]);
  });

  it('matches a/b.ts at a path-segment boundary in recorded text', () => {
    expect(attestedTokens([{ token: 'a/b.ts', claim: 'executed' }], record({ executedText: ['wrote ./a/b.ts and more'] }), CWD)).toEqual(['a/b.ts']);
  });

  it('does not match on a two-segment suffix of a different path', () => {
    expect(attestedTokens([{ token: '/elsewhere/src/a.ts', claim: 'executed' }], record({ executedText: ['changed src/a.ts'] }), CWD)).toEqual([]);
  });
});

describe('what each source attests', () => {
  it('attests an any claim from stated text and not an executed claim', () => {
    const from = record({ statedText: ['look at `make lint`'] });
    expect(attestedTokens([{ token: 'make lint', claim: 'any' }], from, CWD)).toEqual(['make lint']);
    expect(attestedTokens([{ token: 'make lint', claim: 'executed' }], from, CWD)).toEqual([]);
  });

  it('attests hex tokens in output text', () => {
    expect(attestedTokens([{ token: 'abc1234', claim: 'executed' }], record({ executedText: ['commit abc1234 created'] }), CWD)).toEqual(['abc1234']);
  });
});
