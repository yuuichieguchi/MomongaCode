import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const OWNER = 'schema-helpers.ts';
const HELPERS = ['closed', 'closedRequiringAll', 'nullable', 'root', 'string', 'nonEmptyString', 'integer', 'nonNegativeInteger', 'boolean', 'anything', 'enumOf', 'storedEnumOf', 'constant', 'boundedInteger', 'text', 'count'];

const sources = fs
  .readdirSync(sourceDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(sourceDir, name), 'utf8') }));

const declares = (text: string, helper: string): boolean => new RegExp(`^(export )?(const|function) ${helper}\\b`, 'm').test(text);

const importedFromOwner = (text: string): string[] =>
  [...text.matchAll(/import \{([^}]*)\} from '\.\/schema-helpers\.ts';/g)].flatMap((match) => (match[1] ?? '').split(',').map((name) => name.trim()));

describe('the schema helpers have one definition, in protocol/src/schema-helpers.ts', () => {
  it('the helper module exists and declares closed and nullable', () => {
    const owner = sources.find(({ name }) => name === OWNER);
    expect(owner).toBeDefined();
    expect(declares(owner?.text ?? '', 'closed')).toBe(true);
    expect(declares(owner?.text ?? '', 'nullable')).toBe(true);
  });

  it('no other source of protocol declares a schema helper', () => {
    const declarers = sources
      .filter(({ name }) => name !== OWNER)
      .flatMap(({ name, text }) => HELPERS.filter((helper) => declares(text, helper)).map((helper) => `${name}: ${helper}`));
    expect(declarers).toEqual([]);
  });

  it('every source that builds a schema with closed( or nullable( imports it from the helper module', () => {
    const strangers = sources
      .filter(({ name }) => name !== OWNER)
      .flatMap(({ name, text }) =>
        ['closed', 'closedRequiringAll', 'nullable'].filter((helper) => new RegExp(`\\b${helper}\\(`).test(text) && !importedFromOwner(text).includes(helper)).map((helper) => `${name}: ${helper}`),
      );
    expect(strangers).toEqual([]);
  });
});
