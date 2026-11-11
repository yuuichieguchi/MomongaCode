import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandSpecsFor, readPathsOfCommand } from '@momonga/policy';
import { globDirectory } from '../src/path-effects.ts';

const CASES = [
  ['src/*.ts', 'src/*.ts', 'src'],
  ['*.ts', '*.ts', '.'],
  ['/*.ts', '/*.ts', '/'],
  ['/etc/ssl/*.pem', '/etc/ssl/*.pem', '/etc/ssl'],
  ['a/b/c?.md', 'a/b/c?.md', 'a/b'],
  ['a/{b,c}/d.md', 'a/{b,c}/d.md', 'a'],
  ['src/\\*dir/*.ts', 'src/\\*dir/*.ts', 'src/*dir'],
  ['"my dir"/sub/*.ts', 'my dir/sub/*.ts', 'my dir/sub'],
  ["'a?b'/*.md", 'a\\?b/*.md', 'a?b'],
] as const;

describe('the directory of a glob', () => {
  it.each(CASES)('the shell word %s and the pattern %s give %s on both paths', (word, pattern, directory) => {
    expect(globDirectory(pattern)).toBe(directory);
    expect(readPathsOfCommand(`cat ${word}`, commandSpecsFor('darwin'))).toEqual([directory]);
  });

  it('is computed by one function', () => {
    const shell = fs.readFileSync(new URL('../src/shell.ts', import.meta.url), 'utf8');

    expect(shell).not.toMatch(/const globDirectory\b/);
    expect(shell).toMatch(/import \{[^}]*\bglobDirectory\b[^}]*\} from '\.\/path-effects\.ts'/);
  });
});
