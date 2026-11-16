import { describe, expect, it } from 'vitest';
import * as context from '@momonga/context';
import { checkSummary, claimedTokens } from '@momonga/context';
import type { FidelityRecord, FidelitySource } from '@momonga/context';
import { attestedIn } from './fidelity-support.ts';

const CWD = '/proj';

const record = (overrides: Partial<FidelityRecord> = {}): FidelityRecord => ({ executedLeaves: [], executedText: [], statedText: [], ...overrides });

const fabricatedIn = (summary: string, from: FidelityRecord): string[] =>
  checkSummary(summary, { attested: attestedIn(claimedTokens(summary), from, CWD), pinned: '', critical: [], workingState: '' }).fabricated;

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
    const laundering = { attested: [], pinned: '', critical: [], workingState: '', previousSummary: previous } as FidelitySource;
    expect(checkSummary(next, laundering).fabricated).toEqual(['src/new.ts']);
  });
});

it('does not export the attestation of a record: the runtime fold attests sources by event type', () => {
  expect('attestedTokens' in context).toBe(false);
});
