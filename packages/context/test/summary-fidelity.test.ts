import { describe, expect, it } from 'vitest';
import { checkSummary, claimedTokens } from '@momonga/context';
import type { FidelityRecord } from '@momonga/context';
import { attestedIn } from './fidelity-support.ts';

const CWD = '/proj';

const record = (overrides: Partial<FidelityRecord> = {}): FidelityRecord => ({ executedLeaves: [], executedText: [], statedText: [], ...overrides });

type Extra = { pinned?: string; critical?: readonly string[]; workingState?: string };

const check = (summary: string, from: FidelityRecord = record(), extra: Extra = {}) =>
  checkSummary(summary, {
    attested: attestedIn(claimedTokens(summary), from, CWD),
    pinned: extra.pinned ?? '',
    critical: extra.critical ?? [],
    workingState: extra.workingState ?? '',
  });

const sectioned = (parts: Partial<Record<'GOAL' | 'STATE' | 'DONE' | 'TODO' | 'DECISIONS' | 'GUARDRAILS', string>>): string =>
  Object.entries(parts)
    .map(([name, body]) => `${name}:\n${body}`)
    .join('\n');

const allSections = (overrides: Parameters<typeof sectioned>[0]): string =>
  sectioned({ GOAL: 'g', STATE: 's', DONE: 'd', TODO: 't', DECISIONS: 'x', GUARDRAILS: 'y', ...overrides });

describe('token shapes', () => {
  it('flags a backticked token the record does not attest', () => {
    expect(check(allSections({ STATE: 'ran `npm run ghost`' })).fabricated).toEqual(['npm run ghost']);
  });

  it('flags a bare path', () => {
    expect(check(allSections({ DONE: 'changed src/ghost.ts today' })).fabricated).toEqual(['src/ghost.ts']);
  });

  it('flags a hex token of seven characters holding a digit and a letter', () => {
    expect(check(allSections({ DECISIONS: 'pinned abc1234 for now' })).fabricated).toEqual(['abc1234']);
  });

  it('ignores a six-character hex token', () => {
    expect(check(allSections({ STATE: 'saw abc123 once' })).fabricated).toEqual([]);
  });

  it.for(['1234567', '3.14159265', 'defaced', 'effaced'])('does not treat %s as hex', (word) => {
    expect(check(allSections({ STATE: `value ${word} noted` })).fabricated).toEqual([]);
  });

  it('leaves prose claims unchecked', () => {
    expect(check(allSections({ STATE: 'all the tests pass and the bug is gone' })).fabricated).toEqual([]);
  });

  it('lists a repeated fabricated token once', () => {
    expect(check(allSections({ STATE: '`src/a.ts`', DONE: '`src/a.ts`' })).fabricated).toEqual(['src/a.ts']);
  });
});

describe('which text is checked', () => {
  it('exempts TODO, which may name files that do not exist yet', () => {
    expect(check(allSections({ TODO: 'create `src/new.ts`' })).fabricated).toEqual([]);
  });

  it('checks every section but TODO', () => {
    expect(check(allSections({ GOAL: '`src/g.ts`', GUARDRAILS: '`src/h.ts`' })).fabricated).toEqual(['src/g.ts', 'src/h.ts']);
  });

  it('accepts markdown headings without a colon and headings in title case', () => {
    const markdown = '## GOAL\ng\n## STATE\ns\n## DONE\nd\n## TODO\ncreate `src/new.ts`\n## DECISIONS\nx\n## GUARDRAILS\ny';
    expect(check(markdown)).toEqual({ fabricated: [], identifiers: 0, retained: 0, sections: 'complete' });
    expect(check('Goal:\ng\nTodo:\ncreate `src/new.ts`').fabricated).toEqual([]);
    expect(check('- **TODO**\ncreate `src/new.ts`').fabricated).toEqual([]);
  });

  it('exempts only the text between a TODO heading and the next heading', () => {
    expect(check('STATE:\ns\nTODO:\nmake `src/new.ts`\nSTATE:\n`src/ghost.ts`').fabricated).toEqual(['src/ghost.ts']);
    expect(check('STATE:\n`src/a.ts`\nSTATE:\n`src/ghost.ts`', record({ executedLeaves: ['src/a.ts'] })).fabricated).toEqual(['src/ghost.ts']);
    expect(check('STATE:\n`src/ghost.ts`\nSTATE:\ns').fabricated).toEqual(['src/ghost.ts']);
    expect(check('STATE:\nx\nTODO:\ny\nDONE:\n`src/ghost.ts`').fabricated).toEqual(['src/ghost.ts']);
  });

  it('checks the text before the first heading', () => {
    expect(check('Intro `src/ghost.ts`\nSTATE:\ns').fabricated).toEqual(['src/ghost.ts']);
  });

  it('does not take a prose line that starts with a section name for a heading', () => {
    expect(check('TODO list kept in `src/ghost.ts`\nSTATE:\ns').fabricated).toEqual(['src/ghost.ts']);
  });

  it('checks the whole text when no section parses', () => {
    const result = check('We touched `src/ghost.ts` and planned `src/next.ts`');
    expect(result.fabricated).toEqual(['src/ghost.ts', 'src/next.ts']);
    expect(result.sections).toBe('none');
  });
});

describe('tokens as the recorded calls hold them', () => {
  const stateOf = (token: string): string => allSections({ STATE: `ran \`${token}\`` });

  it('accepts a command with quotes from the argument leaf of a call that ran', () => {
    expect(check(stateOf('grep -n "foo" src/a.ts'), record({ executedLeaves: ['grep -n "foo" src/a.ts'] })).fabricated).toEqual([]);
  });

  it('accepts a Windows path by equality with a recorded path and no longer by a two-segment suffix', () => {
    const from = record({ executedLeaves: ['C:\\repo\\src\\a.ts'] });
    expect(check(stateOf('C:\\repo\\src\\a.ts'), from).fabricated).toEqual([]);
    expect(check(stateOf('D:\\other\\src\\a.ts'), from).fabricated).toEqual(['D:\\other\\src\\a.ts']);
    expect(check(stateOf('C:\\repo\\lib\\b.ts'), from).fabricated).toEqual(['C:\\repo\\lib\\b.ts']);
  });

  it.for(['src/a.ts:42', 'src/a.ts:42:7'])('reduces %s to its path', (token) => {
    const from = record({ executedLeaves: ['src/a.ts'] });
    expect(check(stateOf(token), from).fabricated).toEqual([]);
    expect(check(stateOf(token.replace('a.ts', 'ghost.ts')), from).fabricated).toEqual(['src/ghost.ts']);
  });

  it('decodes the entities the transcript wrote', () => {
    expect(check(stateOf('Map&lt;K>'), record({ executedText: ['type Map<K> = 1'] })).fabricated).toEqual([]);
  });

  it('keeps a token that is in no record fabricated after decoding', () => {
    expect(check(stateOf('grep -n "bar" src/a.ts'), record({ executedLeaves: ['grep -n "foo" src/a.ts'] })).fabricated).toEqual(['grep -n "bar" src/a.ts']);
  });
});

describe('where a token may come from', () => {
  const summary = allSections({ STATE: '`src/known.ts`' });

  it('accepts a STATE token found in what ran', () => {
    expect(check(summary, record({ executedText: ['see src/known.ts here'] })).fabricated).toEqual([]);
  });

  it('does not accept a STATE token found only in what the person said or in the pinned text', () => {
    expect(check(summary, record({ statedText: ['see src/known.ts here'] })).fabricated).toEqual(['src/known.ts']);
    expect(check(summary, record(), { pinned: 'see src/known.ts here' }).fabricated).toEqual(['src/known.ts']);
  });

  it('accepts a GOAL token found in the pinned text', () => {
    expect(check(allSections({ GOAL: '`src/known.ts`' }), record(), { pinned: 'see src/known.ts here' }).fabricated).toEqual([]);
  });

  it('does not accept a token found only in the working state', () => {
    expect(check(summary, record(), { workingState: 'src/known.ts' }).fabricated).toEqual(['src/known.ts']);
  });
});

describe('paths relative to the working directory', () => {
  it('matches an absolute path under the working directory against a relative record', () => {
    expect(check(allSections({ STATE: '`/proj/src/a.ts`' }), record({ executedLeaves: ['src/a.ts'] })).fabricated).toEqual([]);
  });

  it('does not match an absolute path elsewhere on a shared suffix', () => {
    expect(check(allSections({ STATE: '`/elsewhere/src/a.ts`' }), record({ executedLeaves: ['src/a.ts'] })).fabricated).toEqual(['/elsewhere/src/a.ts']);
  });

  it('normalises a leading ./', () => {
    expect(check(allSections({ STATE: '`./lib/src/a.ts`' }), record({ executedLeaves: ['/proj/lib/src/a.ts'] })).fabricated).toEqual([]);
  });

  it('does not match on the file name alone', () => {
    expect(check(allSections({ STATE: '`/elsewhere/other/a.ts`' }), record({ executedLeaves: ['src/a.ts'] })).fabricated).toEqual(['/elsewhere/other/a.ts']);
  });
});

describe('retained and sections', () => {
  it('counts critical identifiers present in the summary or the working state', () => {
    const result = check(allSections({ DONE: '`src/a.ts`' }), record({ executedLeaves: ['src/a.ts'] }), { critical: ['src/a.ts', 'npm test', 'src/b.ts'], workingState: 'npm test failed' });
    expect(result.fabricated).toEqual([]);
    expect(result.identifiers).toBe(3);
    expect(result.retained).toBe(2);
  });

  it('is zero of zero with no critical identifier', () => {
    expect(check(allSections({}))).toEqual({ fabricated: [], identifiers: 0, retained: 0, sections: 'complete' });
  });

  it('reports partial when only some sections parse', () => {
    expect(check(sectioned({ GOAL: 'g', STATE: 's' })).sections).toBe('partial');
  });
});
