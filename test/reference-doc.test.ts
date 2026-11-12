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

  it('the README names exactly the settings keys a project or local settings file cannot set', async () => {
    const names = await referenceNames();
    const line = read('README.md').split('\n').find((text) => text.startsWith('Project and local settings cannot set'));
    expect(line).toBeDefined();
    const sentence = (line ?? '').split(';')[0] ?? '';
    const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    expect([...listed].sort()).toEqual([...names.userOnlySettings].sort());
  });
});
