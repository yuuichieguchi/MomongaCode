import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cfgNames, cfgNamesOf } from './cfg-names.ts';

const specDir = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla');

describe('the one reader of a TLC configuration', () => {
  it('returns the constants, the invariants and the properties in the order they are written', () => {
    const text = ['SPECIFICATION Spec', '', 'CONSTANTS', '    N = 2', '    S = {a, b}', '', 'INVARIANTS', '    TypeOK', '    Safe', '', 'PROPERTIES', '    Live', ''].join('\n');
    expect(cfgNamesOf(text, 'x.cfg')).toEqual({ constants: { N: '2', S: '{a, b}' }, invariants: ['TypeOK', 'Safe'], properties: ['Live'] });
  });

  it('fails on a singular INVARIANT or PROPERTY line, so a configuration cannot silently list nothing', () => {
    expect(() => cfgNamesOf('INVARIANT\n    Safe\n', 'a.cfg')).toThrow(/a\.cfg:1: the keyword INVARIANT is written in its plural form INVARIANTS/);
    expect(() => cfgNamesOf('PROPERTY\n    Live\n', 'b.cfg')).toThrow(/b\.cfg:1: the keyword PROPERTY is written in its plural form PROPERTIES/);
  });

  it('fails on names written on the keyword line', () => {
    expect(() => cfgNamesOf('INVARIANTS Safe\n', 'c.cfg')).toThrow(/c\.cfg:1: the names of INVARIANTS stand on the lines below it/);
  });

  it('parses every configuration in specs/tla, and each checks at least one invariant or property', () => {
    const configs = fs.readdirSync(specDir).filter((file) => file.endsWith('.cfg')).map((file) => file.slice(0, -'.cfg'.length));
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      const names = cfgNames(specDir, config);
      expect(names.invariants.length + names.properties.length, config).toBeGreaterThan(0);
    }
  });
});
