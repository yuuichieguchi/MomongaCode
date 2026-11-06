import { describe, expect, it } from 'vitest';
import { checkSummary } from '@momonga/context';

const SUMMARY = 'GOAL:\n`make all`\nSTATE:\n`src/a.ts`\nDONE:\n`npm test`\nTODO:\ncreate `src/new.ts`\nDECISIONS:\nkeep abc1234\nGUARDRAILS:\n`lib/x.ts`';

const checked = (attested: readonly string[]) => checkSummary(SUMMARY, { attested, pinned: '', critical: [], workingState: '' });

describe('checkSummary decides from the attested set', () => {
  it('marks every checked token fabricated when nothing is attested', () => {
    expect(checked([]).fabricated).toEqual(['make all', 'src/a.ts', 'npm test', 'lib/x.ts', 'abc1234']);
  });

  it('marks nothing fabricated when every checked token is attested', () => {
    expect(checked(['make all', 'src/a.ts', 'npm test', 'lib/x.ts', 'abc1234']).fabricated).toEqual([]);
  });

  it('decides each section other than TODO by the attested set alone', () => {
    expect(checked(['src/a.ts', 'npm test']).fabricated).toEqual(['make all', 'lib/x.ts', 'abc1234']);
  });

  it('leaves the TODO token out of the decision', () => {
    expect(checked([]).fabricated).not.toContain('src/new.ts');
  });

  it('takes no region text', () => {
    const withRegion = { attested: [], pinned: '', critical: [], workingState: '', region: SUMMARY } as unknown as Parameters<typeof checkSummary>[1];
    expect(checkSummary(SUMMARY, withRegion).fabricated).toHaveLength(5);
  });
});
