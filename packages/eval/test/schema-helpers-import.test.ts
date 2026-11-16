import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PROTOCOL_HELPERS = ['closed', 'nonEmptyString', 'nonNegativeInteger', 'string'];

const sources = fs
  .readdirSync(sourceDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(sourceDir, name), 'utf8') }));

const declares = (text: string, helper: string): boolean => new RegExp(`^const ${helper}\\b`, 'm').test(text);

describe('the eval package takes its schema helpers from @momonga/protocol', () => {
  it('no eval source declares a helper the protocol package exports', () => {
    const declarers = sources.flatMap(({ name, text }) => PROTOCOL_HELPERS.filter((helper) => declares(text, helper)).map((helper) => `${name}: ${helper}`));
    expect(declarers).toEqual([]);
  });

  it('every eval source that builds a closed schema imports closed from @momonga/protocol', () => {
    const strangers = sources
      .filter(({ text }) => /\bclosed\(/.test(text))
      .filter(({ text }) => !/import \{[^}]*\bclosed\b[^}]*\} from '@momonga\/protocol';/.test(text))
      .map(({ name }) => name);
    expect(strangers).toEqual([]);
  });
});
