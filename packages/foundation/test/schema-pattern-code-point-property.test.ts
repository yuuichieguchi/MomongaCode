import { describe, expect, it } from 'vitest';
import { clearUntrustedSchemaCaches, validateUntrusted } from '@momonga/foundation';
import { seededRandom, type Random } from './seeded-random.ts';

const BMP = ['a', 'b', 'é', 'ж', '中'];
const ASTRAL = ['🐲', '🐉', '😀', '𝒜', '𠀋'];
const ALPHABET = [...BMP, ...ASTRAL];
const CLASSES = ['[🐲🐉]', '[a😀]', '[🐀-🐿]', '[😀-😏a]', '[^🐲]', '[^a-z]', '[𝒜-𝒵中]'];

const atom = (random: Random, depth: number): string => {
  const roll = random.next();
  if (roll < 0.45) return random.pick(ALPHABET);
  if (roll < 0.6) return '.';
  if (roll < 0.8) return random.pick(CLASSES);
  if (depth > 1) return random.pick(ALPHABET);
  return `(${alternation(random, depth + 1)})`;
};

const quantified = (random: Random, depth: number): string => {
  const base = atom(random, depth);
  const roll = random.next();
  if (roll < 0.4) return base;
  if (roll < 0.55) return `${base}*`;
  if (roll < 0.7) return `${base}+`;
  if (roll < 0.8) return `${base}?`;
  const low = random.int(0, 2);
  return `${base}{${low},${low + random.int(0, 2)}}`;
};

const sequence = (random: Random, depth: number): string => {
  const length = random.int(1, 3);
  let text = '';
  for (let index = 0; index < length; index += 1) text += quantified(random, depth);
  return text;
};

const alternation = (random: Random, depth: number): string => (random.next() < 0.25 ? `${sequence(random, depth)}|${sequence(random, depth)}` : sequence(random, depth));

const pattern = (random: Random): string => {
  const body = alternation(random, 0);
  const anchoredStart = random.next() < 0.5;
  const anchoredEnd = random.next() < 0.5;
  return `${anchoredStart ? '^' : ''}${anchoredStart || anchoredEnd ? `(?:${body})` : body}${anchoredEnd ? '$' : ''}`;
};

const subject = (random: Random): string => {
  const length = random.int(0, 6);
  let text = '';
  for (let index = 0; index < length; index += 1) text += random.pick(ALPHABET);
  return text;
};

const SEEDS = [7, 20261106, 0xc0de];
const PATTERNS_PER_SEED = 150;
const SUBJECTS_PER_PATTERN = 8;

describe('pattern through the untrusted-schema boundary matches by code point, as RegExp with the u flag', () => {
  it.each(SEEDS)('seed %i: every verdict equals new RegExp(pattern, "u")', (seed) => {
    clearUntrustedSchemaCaches();
    const random = seededRandom(seed);
    const mismatches: { pattern: string; data: string; expected: boolean; actual: boolean | string }[] = [];
    let astralSubjects = 0;
    for (let index = 0; index < PATTERNS_PER_SEED; index += 1) {
      const source = pattern(random);
      const native = new RegExp(source, 'u');
      for (let count = 0; count < SUBJECTS_PER_PATTERN; count += 1) {
        const data = subject(random);
        if ([...data].some((character) => character.length === 2)) astralSubjects += 1;
        const expected = native.test(data);
        let actual: boolean | string;
        try {
          actual = validateUntrusted('pattern-code-point', { type: 'string', pattern: source }, data).valid;
        } catch (error) {
          actual = `threw: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (actual !== expected) mismatches.push({ pattern: source, data, expected, actual });
      }
    }
    expect(astralSubjects).toBeGreaterThan((PATTERNS_PER_SEED * SUBJECTS_PER_PATTERN) / 2);
    expect(mismatches).toEqual([]);
  });

  it.each([
    ['^🐲*$', '🐲🐲', true],
    ['^🐲*$', '', true],
    ['^.$', '🐲', true],
    ['^..$', '🐲', false],
    ['^[🐀-🐿]$', '🐲', true],
    ['^[^🐲]$', '🐉', true],
    ['^🐲{2}$', '🐲🐲', true],
  ])('%s against %s is valid=%s', (source, data, expected) => {
    clearUntrustedSchemaCaches();
    expect(validateUntrusted('pattern-code-point-fixed', { type: 'string', pattern: source }, data).valid).toBe(expected);
  });
});
