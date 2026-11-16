import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { attachSwitchLabel, attachedRow, candidatePathsOf, completedMention, hasMentionToken, imageSpanLabel, mentionTokenAt, rankCandidates, scoreOf } from '../../src/tui/attach.ts';

const rank = (entries: readonly string[], query: string, limit = 7) => rankCandidates(entries, query, { limit, pause: async () => undefined, cancelled: () => false });

describe('the @ token under the caret (design 5.7)', () => {
  it('is found at the start of the buffer and after whitespace', () => {
    expect(mentionTokenAt('@src/a', 6)).toEqual({ start: 0, query: 'src/a', quoted: false });
    expect(mentionTokenAt('fix @ap', 7)).toEqual({ start: 4, query: 'ap', quoted: false });
    expect(mentionTokenAt('fix\n@', 5)).toEqual({ start: 4, query: '', quoted: false });
  });

  it('is not found inside a word, after the token has ended, or before the caret reaches it', () => {
    expect(mentionTokenAt('me@example.com', 14)).toBeUndefined();
    expect(mentionTokenAt('@a.ts and', 9)).toBeUndefined();
    expect(mentionTokenAt('@a.ts', 0)).toBeUndefined();
  });

  it('keeps going through spaces inside an open quote', () => {
    expect(mentionTokenAt('see @"my fi', 11)).toEqual({ start: 4, query: 'my fi', quoted: true });
  });

  it('tells whether a text names a file at all', () => {
    expect(hasMentionToken('explain @src/app.tsx')).toBe(true);
    expect(hasMentionToken('@"my file.txt"')).toBe(true);
    expect(hasMentionToken('mail me@example.com')).toBe(false);
    expect(hasMentionToken('nothing here')).toBe(false);
  });
});

describe('the candidates', () => {
  it('are the listed files and every directory above them, with a trailing slash on directories', () => {
    expect(candidatePathsOf(['src/lib/x.ts', 'src/app.tsx', 'a.ts'])).toEqual(['src/', 'src/lib/', 'src/lib/x.ts', 'src/app.tsx', 'a.ts']);
  });

  it('list an entry that starts with a dot only when the query starts with a dot', () => {
    expect(scoreOf('.env', '')).toBeUndefined();
    expect(scoreOf('.env', 'e')).toBeUndefined();
    expect(scoreOf('.env', '.')).toBeDefined();
    expect(scoreOf('src/.eslintrc', 'es')).toBeDefined();
  });

  it('are ranked by how the query matches: the path start, the name start, a part, then scattered letters', async () => {
    const entries = ['docs/app-notes.md', 'src/app.tsx', 'app/', 'src/a/p/p.ts', 'zzz.ts'];
    expect(await rank(entries, 'app')).toEqual(['app/', 'src/app.tsx', 'docs/app-notes.md', 'src/a/p/p.ts']);
  });

  it('ignore the letter case and keep at most the asked number', async () => {
    expect(await rank(['src/Readme', 'readme.txt', 'README.md'], 'READ', 2)).toEqual(['README.md', 'readme.txt']);
  });

  it('list the shortest paths first for an empty query', async () => {
    expect(await rank(['src/lib/deep.ts', 'b.ts', 'src/', '.git/'], '')).toEqual(['b.ts', 'src/', 'src/lib/deep.ts']);
  });

  it('give no result when the job was replaced while it ranked', async () => {
    const entries = Array.from({ length: 5000 }, (_unused, index) => `f${index}.ts`);
    let pauses = 0;
    const ranked = await rankCandidates(entries, 'f', { limit: 7, pause: async () => void (pauses += 1), cancelled: () => pauses > 0 });
    expect(ranked).toBeUndefined();
    expect(pauses).toBe(1);
  });
});

describe('completing the token', () => {
  it('replaces @query with @path and a space for a file', () => {
    const token = mentionTokenAt('fix @ap now', 7);
    if (token === undefined) throw new Error('no token');
    expect(completedMention('fix @ap now', 7, token, 'src/app.tsx')).toEqual({ text: 'fix @src/app.tsx  now', cursor: 17 });
  });

  it('keeps a directory open with its trailing slash', () => {
    const token = mentionTokenAt('@sr', 3);
    if (token === undefined) throw new Error('no token');
    expect(completedMention('@sr', 3, token, 'src/')).toEqual({ text: '@src/', cursor: 5 });
  });

  it('quotes a path with whitespace, and leaves the quote open on a directory', () => {
    const token = mentionTokenAt('@my', 3);
    if (token === undefined) throw new Error('no token');
    expect(completedMention('@my', 3, token, 'my file.txt')).toEqual({ text: '@"my file.txt" ', cursor: 15 });
    expect(completedMention('@my', 3, token, 'my dir/')).toEqual({ text: '@"my dir/', cursor: 9 });
  });
});

describe('the texts of the attach rows', () => {
  it('name the switch with the key of the list that decides', () => {
    expect(attachSwitchLabel(true, DEFAULT_KEY_TABLE)).toBe('Attach file contents: on (enter to turn off)');
    expect(attachSwitchLabel(false, DEFAULT_KEY_TABLE)).toBe('Attach file contents: off (enter to turn on)');
  });

  it('show one row per attached file and the label of a pasted image', () => {
    expect(attachedRow({ type: 'attached_file', path: 'src/app.tsx', lines: 412 })).toBe('attached src/app.tsx (412 lines)');
    expect(imageSpanLabel(2)).toBe('[Image #2]');
  });
});
