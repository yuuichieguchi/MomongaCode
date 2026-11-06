import { describe, expect, it } from 'vitest';
import { ataEngine, createUntrustedBoundary } from '@momonga/foundation';

const ASSERTING = 'https://meta.example.test/hostname-total';

const meta = {
  $id: ASSERTING,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true, 'https://json-schema.org/draft/2020-12/vocab/format-assertion': true },
  $dynamicAnchor: 'meta',
};

const boundary = createUntrustedBoundary({ remotes: new Map<string, unknown>([[ASSERTING, meta]]), engine: ataEngine });

const LENGTH = 1_000_000;

const hostile: [string, string][] = [
  ['plain letters', 'a'.repeat(LENGTH)],
  ['dots', '.'.repeat(LENGTH)],
  ['labels', 'a.'.repeat(LENGTH / 2)],
  ['ideographic full stops', '。'.repeat(LENGTH)],
  ['punycode prefixes', 'xn--'.repeat(LENGTH / 4)],
  ['punycode labels', 'xn--a.'.repeat(LENGTH / 6)],
  ['one punycode label', `xn--${'a'.repeat(LENGTH)}`],
  ['non-ASCII letters', 'é'.repeat(LENGTH)],
  ['astral letters', '\u{1F432}'.repeat(LENGTH / 2)],
];

describe.each(['hostname', 'idn-hostname'])('format %s is total and answers false for a string of a million characters', (format) => {
  it.each(hostile)('%s', (_name, data) => {
    const schema = { $schema: ASSERTING, type: 'string', format };
    expect(boundary.validate(`total:${format}`, schema, data).valid).toBe(false);
  });
});

describe('idn-hostname still answers a name padded with ignorable code points by its mapped form', () => {
  it('accepts a valid name with a few ignorable code points and rejects one whose mapped form is too long', () => {
    const schema = { $schema: ASSERTING, type: 'string', format: 'idn-hostname' };
    expect(boundary.validate('total:ignorable', schema, `a​b`).valid).toBe(true);
    expect(boundary.validate('total:ignorable', schema, `${'a'.repeat(300)}​`).valid).toBe(false);
  });
});
