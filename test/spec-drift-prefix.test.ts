import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREFIX_EVENTS } from '@momonga/protocol';

const specPath = path.resolve(import.meta.dirname, '..', 'specs', 'tla', 'RequestPrefix.tla');
const spec = fs.readFileSync(specPath, 'utf8');

const namedEvents = (): string[] => {
  const match = /^NamedEvents\s*==\s*\{([^}]*)\}/m.exec(spec);
  if (match === null) throw new Error(`NamedEvents is not defined as a set in ${specPath}`);
  const names = [...(match[1] as string).matchAll(/"([^"]+)"/g)].map((name) => name[1] as string);
  if (names.length === 0) throw new Error(`NamedEvents in ${specPath} is empty`);
  return names;
};

describe('RequestPrefix.tla matches the code', () => {
  it('names exactly the prefix events of PREFIX_EVENTS, each once', () => {
    const spec = namedEvents();
    const code = [...PREFIX_EVENTS];
    expect(new Set(spec).size).toBe(spec.length);
    expect(new Set(code).size).toBe(code.length);
    expect([...spec].sort()).toEqual([...code].sort());
  });
});
