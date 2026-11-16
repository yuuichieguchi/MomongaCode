import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ROOT, lineOf, parseSource, parsedProductSource, productSources, relativeOf, stringPartsOf } from './support/source-scan.ts';
import type { ParsedSource } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const DESCRIPTION_FILE = 'packages/protocol/src/managed-servers.ts';

const SERVER_IDS = ['fm', 'mine', 'loom', 'anvil', 'kiln'];

const namesOf = (source: ParsedSource, id: string): string[] =>
  stringPartsOf(source)
    .filter(({ text }) => text === id)
    .map(({ node }) => `${relativeOf(source.file)}:${lineOf(source, node)}`);

const namedIn = (text: string, id: string): number => namesOf(parseSource('sample.ts', text), id).length;

describe('no product code names a managed or declared server id outside the built-in description file (design-managed-servers 3.1 and 19.8, AT1; R-S19-19)', () => {
  it('finds an id written as a whole string of any quote, and not a longer text that holds it', () => {
    expect(namedIn("if (server.id === 'fm') start();", 'fm')).toBe(1);
    expect(namedIn('if (server.id === "fm") start();', 'fm')).toBe(1);
    expect(namedIn('const id = `fm`;', 'fm')).toBe(1);
    expect(namedIn("const text = 'fm server';\nconst name = format;", 'fm')).toBe(0);
  });

  it('keeps the description file, the one allowed place', () => {
    expect(fs.existsSync(path.join(ROOT, DESCRIPTION_FILE))).toBe(true);
  });

  it.each(SERVER_IDS)('finds the id %s in no product source', (id) => {
    const found = productSources()
      .filter((file) => relativeOf(file) !== DESCRIPTION_FILE)
      .flatMap((file) => namesOf(parsedProductSource(file), id));
    expect(found).toEqual([]);
  });
});
