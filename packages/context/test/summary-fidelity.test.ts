import { describe, expect, it } from 'vitest';
import { checkSummary, textOfItem } from '@momonga/context';
import type { FidelitySource } from '@momonga/context';

const source = (overrides: Partial<FidelitySource> = {}): FidelitySource => ({
  region: '',
  pinned: '',
  previousSummary: '',
  critical: [],
  workingState: '',
  ...overrides,
});

const sectioned = (parts: Partial<Record<'GOAL' | 'STATE' | 'DONE' | 'TODO' | 'DECISIONS' | 'GUARDRAILS', string>>): string =>
  Object.entries(parts)
    .map(([name, body]) => `${name}:\n${body}`)
    .join('\n');

const allSections = (overrides: Parameters<typeof sectioned>[0]): string =>
  sectioned({ GOAL: 'g', STATE: 's', DONE: 'd', TODO: 't', DECISIONS: 'x', GUARDRAILS: 'y', ...overrides });

describe('token shapes', () => {
  it('flags a backticked token absent from every source', () => {
    expect(checkSummary(allSections({ STATE: 'ran `npm run ghost`' }), source()).fabricated).toEqual(['npm run ghost']);
  });

  it('flags a bare path', () => {
    expect(checkSummary(allSections({ DONE: 'changed src/ghost.ts today' }), source()).fabricated).toEqual(['src/ghost.ts']);
  });

  it('flags a hex token of seven characters holding a digit and a letter', () => {
    expect(checkSummary(allSections({ DECISIONS: 'pinned abc1234 for now' }), source()).fabricated).toEqual(['abc1234']);
  });

  it('ignores a six-character hex token', () => {
    expect(checkSummary(allSections({ STATE: 'saw abc123 once' }), source()).fabricated).toEqual([]);
  });

  it.for(['1234567', '3.14159265', 'defaced', 'effaced'])('does not treat %s as hex', (word) => {
    expect(checkSummary(allSections({ STATE: `value ${word} noted` }), source()).fabricated).toEqual([]);
  });

  it('leaves prose claims unchecked', () => {
    expect(checkSummary(allSections({ STATE: 'all the tests pass and the bug is gone' }), source()).fabricated).toEqual([]);
  });

  it('lists a repeated fabricated token once', () => {
    expect(checkSummary(allSections({ STATE: '`src/a.ts`', DONE: '`src/a.ts`' }), source()).fabricated).toEqual(['src/a.ts']);
  });
});

describe('which text is checked', () => {
  it('exempts TODO, which may name files that do not exist yet', () => {
    expect(checkSummary(allSections({ TODO: 'create `src/new.ts`' }), source()).fabricated).toEqual([]);
  });

  it('checks every section but TODO', () => {
    expect(checkSummary(allSections({ GOAL: '`src/g.ts`', GUARDRAILS: '`src/h.ts`' }), source()).fabricated).toEqual(['src/g.ts', 'src/h.ts']);
  });

  it('accepts markdown headings without a colon and headings in title case', () => {
    const markdown = '## GOAL\ng\n## STATE\ns\n## DONE\nd\n## TODO\ncreate `src/new.ts`\n## DECISIONS\nx\n## GUARDRAILS\ny';
    expect(checkSummary(markdown, source())).toEqual({ fabricated: [], identifiers: 0, retained: 0, sections: 'complete' });
    expect(checkSummary('Goal:\ng\nTodo:\ncreate `src/new.ts`', source()).fabricated).toEqual([]);
    expect(checkSummary('- **TODO**\ncreate `src/new.ts`', source()).fabricated).toEqual([]);
  });

  it('exempts only the text between a TODO heading and the next heading', () => {
    expect(checkSummary('STATE:\ns\nTODO:\nmake `src/new.ts`\nSTATE:\n`src/ghost.ts`', source()).fabricated).toEqual(['src/ghost.ts']);
    expect(checkSummary('STATE:\n`src/a.ts`\nSTATE:\n`src/ghost.ts`', source({ region: 'src/a.ts' })).fabricated).toEqual(['src/ghost.ts']);
    expect(checkSummary('STATE:\n`src/ghost.ts`\nSTATE:\ns', source()).fabricated).toEqual(['src/ghost.ts']);
    expect(checkSummary('STATE:\nx\nTODO:\ny\nDONE:\n`src/ghost.ts`', source()).fabricated).toEqual(['src/ghost.ts']);
  });

  it('checks the text before the first heading', () => {
    expect(checkSummary('Intro `src/ghost.ts`\nSTATE:\ns', source()).fabricated).toEqual(['src/ghost.ts']);
  });

  it('does not take a prose line that starts with a section name for a heading', () => {
    expect(checkSummary('TODO list kept in `src/ghost.ts`\nSTATE:\ns', source()).fabricated).toEqual(['src/ghost.ts']);
  });

  it('checks the whole text when no section parses', () => {
    const result = checkSummary('We touched `src/ghost.ts` and planned `src/next.ts`', source());
    expect(result.fabricated).toEqual(['src/ghost.ts', 'src/next.ts']);
    expect(result.sections).toBe('none');
  });
});

describe('tokens as the recorded call items hold them', () => {
  const regionOf = (name: string, input: Record<string, unknown>): string =>
    textOfItem({ type: 'function_call', call_id: 'c1', name, arguments: JSON.stringify(input) });
  const stateOf = (token: string): string => allSections({ STATE: `ran \`${token}\`` });

  it('accepts a command with quotes', () => {
    const region = regionOf('Bash', { command: 'grep -n "foo" src/a.ts' });
    expect(checkSummary(stateOf('grep -n "foo" src/a.ts'), source({ region })).fabricated).toEqual([]);
  });

  it('accepts a Windows path', () => {
    const region = regionOf('Write', { file_path: 'C:\\repo\\src\\a.ts', content: 'x' });
    expect(checkSummary(stateOf('C:\\repo\\src\\a.ts'), source({ region })).fabricated).toEqual([]);
    expect(checkSummary(stateOf('D:\\other\\src\\a.ts'), source({ region })).fabricated).toEqual([]);
    expect(checkSummary(stateOf('C:\\repo\\lib\\b.ts'), source({ region })).fabricated).toEqual(['C:\\repo\\lib\\b.ts']);
  });

  it.for(['src/a.ts:42', 'src/a.ts:42:7'])('reduces %s to its path', (token) => {
    expect(checkSummary(stateOf(token), source({ region: 'src/a.ts' })).fabricated).toEqual([]);
    expect(checkSummary(stateOf(token.replace('a.ts', 'ghost.ts')), source({ region: 'src/a.ts' })).fabricated).toEqual(['src/ghost.ts']);
  });

  it('decodes the entities the transcript wrote', () => {
    expect(checkSummary(stateOf('Map&lt;K>'), source({ region: 'type Map<K> = 1' })).fabricated).toEqual([]);
  });

  it('keeps a token that is in no source fabricated after decoding', () => {
    const region = regionOf('Bash', { command: 'grep -n "foo" src/a.ts' });
    expect(checkSummary(stateOf('grep -n "bar" src/a.ts'), source({ region })).fabricated).toEqual(['grep -n "bar" src/a.ts']);
  });
});

describe('where a token may come from', () => {
  const summary = allSections({ STATE: '`src/known.ts`' });

  it.for(['region', 'pinned', 'previousSummary'] as const)('accepts a token found in %s', (field) => {
    expect(checkSummary(summary, source({ [field]: 'see src/known.ts here' })).fabricated).toEqual([]);
  });

  it('does not accept a token found only in the working state', () => {
    expect(checkSummary(summary, source({ workingState: 'src/known.ts' })).fabricated).toEqual(['src/known.ts']);
  });
});

describe('path suffixes', () => {
  it('matches a suffix of two segments', () => {
    expect(checkSummary(allSections({ STATE: '`/elsewhere/src/a.ts`' }), source({ region: 'src/a.ts' })).fabricated).toEqual([]);
  });

  it('normalises a leading ./', () => {
    expect(checkSummary(allSections({ STATE: '`./lib/src/a.ts`' }), source({ region: '/proj/lib/src/a.ts' })).fabricated).toEqual([]);
  });

  it('does not match on the file name alone', () => {
    expect(checkSummary(allSections({ STATE: '`/elsewhere/other/a.ts`' }), source({ region: 'src/a.ts' })).fabricated).toEqual(['/elsewhere/other/a.ts']);
  });
});

describe('retained and sections', () => {
  it('counts critical identifiers present in the summary or the working state', () => {
    const result = checkSummary(allSections({ DONE: '`src/a.ts`' }), source({ region: 'src/a.ts', critical: ['src/a.ts', 'npm test', 'src/b.ts'], workingState: 'npm test failed' }));
    expect(result.identifiers).toBe(3);
    expect(result.retained).toBe(2);
  });

  it('is zero of zero with no critical identifier', () => {
    const result = checkSummary(allSections({}), source());
    expect(result).toEqual({ fabricated: [], identifiers: 0, retained: 0, sections: 'complete' });
  });

  it('reports partial when only some sections parse', () => {
    expect(checkSummary(sectioned({ GOAL: 'g', STATE: 's' }), source()).sections).toBe('partial');
  });
});
