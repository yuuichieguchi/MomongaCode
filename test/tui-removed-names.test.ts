import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SLASH_COMMANDS } from '../packages/cli/src/tui/slash.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

const REMOVED = ['slashCompletion', 'clipDiff', 'maxDiffLines', 'PROMPT_BORDER_LINES', 'PROMPT_TITLE_LINES', 'PROMPT_HINT_LINES', 'PROMPT_OMITTED_NOTICE_LINES', 'STATUS_LINE_LINES'] as const;

const sourcesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe('the terminal UI keeps no export without a product caller', () => {
  it('no source or test names a removed export or imports tui/diff.ts', () => {
    const found = [...sourcesUnder(path.join(ROOT, 'packages', 'cli')), ...sourcesUnder(path.join(ROOT, 'test'))]
      .filter((file) => file !== import.meta.filename)
      .flatMap((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return [...REMOVED.filter((name) => new RegExp(`\\b${name}\\b`).test(text)), ...(/tui\/diff\.ts|from '\.\.?\/diff\.ts'/.test(text) && !file.includes(`${path.sep}screen${path.sep}`) ? ['tui/diff.ts'] : [])].map((name) => `${path.relative(ROOT, file)}: ${name}`);
      });
    expect(found).toEqual([]);
  });

  it('has no built-in /model whose listing the terminal UI always replaces', () => {
    expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain('model');
  });
});
