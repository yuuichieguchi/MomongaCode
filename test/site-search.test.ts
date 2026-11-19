import { describe, expect, it } from 'vitest';
import { searchRecords } from '../site/client/search.ts';
import type { SearchRecord } from '../site/client/search.ts';

const SANDBOX: SearchRecord = { url: '/docs/features#sandbox', title: 'Sandbox', text: 'Bash runs under Seatbelt on macOS and bubblewrap on Linux.' };
const HOOKS: SearchRecord = { url: '/docs/features#hooks', title: 'Hooks', text: 'Commands run on PreToolUse. A hook that exits with code 2 blocks the sandbox call.' };
const INSTALL: SearchRecord = { url: '/docs/installation', title: 'Installation', text: 'macOS and Linux: curl the installer.' };
const RECORDS: readonly SearchRecord[] = [HOOKS, INSTALL, SANDBOX];

describe('searchRecords', () => {
  it('returns no record for an empty query', () => {
    expect(searchRecords(RECORDS, '')).toEqual([]);
  });

  it('returns no record for a query of only whitespace', () => {
    expect(searchRecords(RECORDS, '   \t ')).toEqual([]);
  });

  it('matches a term in the title regardless of case', () => {
    expect(searchRecords(RECORDS, 'INSTALLATION')).toEqual([INSTALL]);
  });

  it('matches a term in the text regardless of case', () => {
    expect(searchRecords(RECORDS, 'BUBBLEWRAP')).toEqual([SANDBOX]);
  });

  it('requires every whitespace-separated term to occur', () => {
    expect(searchRecords(RECORDS, 'macos  bubblewrap')).toEqual([SANDBOX]);
    expect(searchRecords(RECORDS, 'macos nothing-like-this')).toEqual([]);
  });

  it('accepts terms split between the title and the text', () => {
    expect(searchRecords(RECORDS, 'hooks pretooluse')).toEqual([HOOKS]);
  });

  it('ranks a title match before a match only in the text', () => {
    expect(searchRecords(RECORDS, 'sandbox')).toEqual([SANDBOX, HOOKS]);
  });

  it('returns no record when nothing matches', () => {
    expect(searchRecords(RECORDS, 'zzz')).toEqual([]);
  });

  it('does not change the records it is given', () => {
    const records = [...RECORDS];
    searchRecords(records, 'sandbox');
    expect(records).toEqual([HOOKS, INSTALL, SANDBOX]);
  });
});
