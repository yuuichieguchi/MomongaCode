import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { TUI_FIXTURE_DIRECTORY, tuiFixtureFiles } from './fixtures-tui.ts';

describe('the terminal protocol fixtures', () => {
  it('are exactly the files the generator writes, byte for byte', () => {
    const directory = path.join(repoRoot, TUI_FIXTURE_DIRECTORY);
    const generated = tuiFixtureFiles();
    expect(fs.readdirSync(directory).sort()).toEqual(Object.keys(generated).sort());
    for (const [file, text] of Object.entries(generated)) expect(fs.readFileSync(path.join(directory, file), 'utf8'), file).toBe(text);
  });

  it('name each fixture by its file and its primary source', () => {
    for (const [file, text] of Object.entries(tuiFixtureFiles())) {
      const parsed: unknown = JSON.parse(text);
      expect(parsed).toMatchObject({ name: file.replace(/\.json$/, ''), source: expect.stringMatching(/\S/) });
    }
  });
});
