import { describe, expect, it } from 'vitest';
import { programKeysOfConfig } from '@momonga/foundation';

describe('programKeysOfConfig names the per-name keys that start a program', () => {
  it('finds nothing in an ordinary submodule configuration', () => {
    const text = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tworktree = ../../../sm\n[remote "origin"]\n\turl = https://example.invalid/sm.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n';
    expect(programKeysOfConfig(text)).toEqual([]);
  });

  it.each([
    ['[filter "x"]\n\tclean = cat\n', ['filter.x.clean']],
    ['[filter "x"]\n\tsmudge = cat\n\tprocess = p\n', ['filter.x.smudge', 'filter.x.process']],
    ['[diff]\n\texternal = prog\n', ['diff.external']],
    ['[diff "d"]\n\ttextconv = prog\n\tcommand = prog\n', ['diff.d.textconv', 'diff.d.command']],
    ['[diff.d]\n\ttextconv = prog\n', ['diff.d.textconv']],
    ['[FILTER "X"]\n\tCLEAN = cat\n', ['filter.X.clean']],
    ['[filter "x"] clean = cat\n', ['filter.x.clean']],
    ['[include]\n\tpath = ../other\n', ['include']],
    ['[includeIf "gitdir:/a/"]\n\tpath = ../other\n', ['include']],
  ])('%j', (text, expected) => {
    expect(programKeysOfConfig(text)).toEqual(expected);
  });

  it('ignores comments, other keys of a driver section and a program word inside a value', () => {
    const text = '# [filter "x"]\n; clean = cat\n[filter "x"]\n\trequired = true\n[diff "d"]\n\tbinary = true\n\tcachetextconv = true\n[alias]\n\tx = clean = y\n';
    expect(programKeysOfConfig(text)).toEqual([]);
  });

  it('does not read the line after a continued value as a key', () => {
    expect(programKeysOfConfig('[alias]\n\ta = b \\\n\tclean = c\n')).toEqual([]);
  });
});
