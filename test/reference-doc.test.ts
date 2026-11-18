import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { referenceNames, renderReference } from '../scripts/reference.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const proseOf = (markdown: string): string => markdown.replace(/^```[\s\S]*?^```$/gm, '');

const inlineCode = (markdown: string): string[] => [...proseOf(markdown).matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');

const commandPathOf = (written: string): string => {
  const words: string[] = [];
  for (const word of written.split(/\s+/).slice(1)) {
    if (!/^[a-z][a-z-]*$/.test(word)) break;
    words.push(word);
  }
  return words.join(' ');
};

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

describe('the generated reference', () => {
  it('docs/reference.md is what scripts/reference.ts generates from the product now', async () => {
    expect(read('docs/reference.md')).toBe(await renderReference());
  });

  it('every command, settings key and environment variable the README names is one the reference lists', async () => {
    const names = await referenceNames();
    const unknown: string[] = [];
    for (const written of inlineCode(read('README.md'))) {
      if (written.startsWith('momonga ')) {
        const command = commandPathOf(written);
        if (command !== '' && !names.commands.has(command)) unknown.push(`command ${command}`);
        continue;
      }
      const [name = ''] = written.split('=');
      if (ENVIRONMENT_NAME.test(name)) {
        if (!names.environment.has(name)) unknown.push(`environment variable ${name}`);
        continue;
      }
      const [first = ''] = written.split('.');
      if (/^[a-zA-Z.]+$/.test(written) && written.includes('.') && names.topLevelSettings.has(first) && !names.settings.has(written)) unknown.push(`settings key ${written}`);
    }
    expect(unknown).toEqual([]);
  });

  it('every option the README writes after a momonga command is one that command or the root takes', async () => {
    const names = await referenceNames();
    const shellLines = [...read('README.md').matchAll(/^ *```(?:sh|text)?\n([\s\S]*?)^ *```$/gm)].flatMap((block) => (block[1] ?? '').split('\n').map((line) => line.trim()));
    const written = [...inlineCode(read('README.md')), ...shellLines].filter((text) => text.startsWith('momonga '));
    const unknown = written.flatMap((text) => {
      const command = commandPathOf(text);
      const taken = names.options.get(command) ?? new Set<string>();
      return text
        .split(/\s+/)
        .map((word) => word.replace(/^\[/, '').replace(/[\]|].*$/, '').split('=')[0] ?? '')
        .filter((flag) => /^--?[a-zA-Z]/.test(flag) && !taken.has(flag))
        .map((flag) => `${text}: ${flag}`);
    });
    expect(unknown).toEqual([]);
  });

  it('the README names exactly the settings keys a project or local settings file cannot set', async () => {
    const names = await referenceNames();
    const line = read('README.md').split('\n').find((text) => text.startsWith('Project and local settings cannot set'));
    expect(line).toBeDefined();
    const sentence = (line ?? '').split(';')[0] ?? '';
    const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    expect([...listed].sort()).toEqual([...names.userOnlySettings].sort());
  });
});

describe('the settings table of the reference', () => {
  const rowOf = (markdown: string, key: string): string => markdown.split('\n').find((line) => line.startsWith(`| \`${key}\` |`)) ?? '';

  it('states the default and the unit the schema holds for each key', async () => {
    const reference = await renderReference();
    expect(reference).toContain('| Key | Value | Default | Unit | Layer |');
    expect(rowOf(reference, 'memory.forgetAfterDays')).toMatch(/\| `90` \| days \|/);
    expect(rowOf(reference, 'sandboxNetwork')).toContain('`"ask"`');
    expect(rowOf(reference, 'context.autoCompact')).toContain('| `true` |');
    expect(rowOf(reference, 'sandbox')).toContain('`"seatbelt"` when `/usr/bin/sandbox-exec` is executable; `"bubblewrap"` when `/usr/bin/bwrap` is executable');
    expect(rowOf(reference, 'hooks.<name>[].hooks[].timeout')).toMatch(/\| `600`; `UserPromptSubmit`: `30` \| seconds \|/);
    expect(rowOf(reference, 'limits.maxCostUsd')).toContain('| USD |');
  });
});
