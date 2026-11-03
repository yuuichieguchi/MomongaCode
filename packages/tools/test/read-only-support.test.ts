import { describe, expect, it } from 'vitest';
import { withoutRefusedXcrunCacheWrite } from './read-only-support.ts';

const REFUSED = (program: string): string => `${program}: error: couldn't create cache file '/var/folders/x4/T/xcrun_db-RizYh5pC' (errno=Operation not permitted)\n`;

describe('withoutRefusedXcrunCacheWrite', () => {
  it.each(['xcrun', 'git', 'make'])('removes the refused cache line the %s shim prints, on darwin', (program) => {
    expect(withoutRefusedXcrunCacheWrite(`${REFUSED(program)}one`, 'darwin')).toBe('one');
  });

  it('removes the line wherever it stands in the output', () => {
    expect(withoutRefusedXcrunCacheWrite(`first\n${REFUSED('git')}second`, 'darwin')).toBe('first\nsecond');
  });

  it('keeps other error lines of a shim program', () => {
    const other = "git: error: couldn't open the repository\n";
    expect(withoutRefusedXcrunCacheWrite(`${other}one`, 'darwin')).toBe(`${other}one`);
  });

  it('keeps the line off darwin', () => {
    expect(withoutRefusedXcrunCacheWrite(`${REFUSED('git')}one`, 'linux')).toBe(`${REFUSED('git')}one`);
  });
});
