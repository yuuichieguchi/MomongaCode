import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { INVALID_GRANT_REASON, PLAN_DISABLED_STATE, PLAN_REVOCATION_ANSWERS, PLAN_SIGN_IN_FAILURES, PLAN_STORE_STATES, RETRY_OUTCOME, SIGNED_IN_OUTCOME } from '@momonga/protocol';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const ROOT = path.resolve(import.meta.dirname, '..');

const PROTOCOL = 'packages/protocol/src/';
const CREDENTIAL_STORE_OWN_CODES = 'packages/foundation/src/encrypted-credential-store.ts';
const PROVIDER_WIRE_VALUES = 'packages/gateway/src/plan/oauth-wire.ts';
const FAKE_PROVIDERS = 'packages/testkit/src/';

const PLAN_SURFACES: readonly string[] = [
  'packages/gateway/src/plan/',
  'packages/cli/src/plan/',
  'packages/cli/src/commands/auth.ts',
  'packages/cli/src/tui/plan-flows.ts',
  'packages/cli/src/client/gateway-client.ts',
];

const UNMISTAKABLE_WORDS: readonly string[] = [...PLAN_STORE_STATES, ...PLAN_SIGN_IN_FAILURES, PLAN_DISABLED_STATE, SIGNED_IN_OUTCOME];
const EVERYDAY_WORDS: readonly string[] = [RETRY_OUTCOME, INVALID_GRANT_REASON, ...PLAN_REVOCATION_ANSWERS];

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const literalPatterns = (word: string): RegExp[] => [new RegExp(`(['"\`])${escaped(word)}\\1`, 'g'), new RegExp(`(?<![\\w$.'"\`])${escaped(word)}\\s*:(?!:)`, 'g')];

const templatePartPattern = (word: string): RegExp => new RegExp(`\`(?:[^\`\\\\]|\\\\.)*(?<![\\w$])${escaped(word)}(?![\\w$])(?:[^\`\\\\]|\\\\.)*\``, 'g');

const linesOf = (source: string, patterns: readonly RegExp[]): number[] =>
  [...new Set(patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => source.slice(0, match.index).split('\n').length)))].sort((a, b) => a - b);

const unmistakableLines = (source: string): number[] => linesOf(source, UNMISTAKABLE_WORDS.flatMap((word) => [...literalPatterns(word), templatePartPattern(word)]));

const everydayLines = (source: string): number[] => linesOf(source, EVERYDAY_WORDS.flatMap(literalPatterns));

const sourceFiles = (relative: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, relative), { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:ts|tsx|mts|mjs|js)$/.test(name) && !/\.generated\.ts$/.test(name) && !name.split(path.sep).includes('node_modules'))
    .map((name) => path.join(relative, name).split(path.sep).join('/'))
    .sort();

const within = (file: string, places: readonly string[]): boolean => places.some((place) => file === place || (place.endsWith('/') && file.startsWith(place)));

const productFiles = (): string[] => [
  ...fs
    .readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => fs.existsSync(path.join(ROOT, 'packages', name, 'src')))
    .flatMap((name) => sourceFiles(path.join('packages', name, 'src'))),
  ...sourceFiles('scripts').filter((file) => !/\.test\.ts$/.test(file)),
];

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('A4: a word of the plan API produced or matched in code is a protocol constant', () => {
  it('no literal, object key or template part equal to a store state, a sign-in failure code, plan_disabled or signed_in outside protocol, the credential store\'s own codes, the provider\'s wire values and the fake providers', () => {
    const scanned = productFiles().filter((file) => !within(file, [PROTOCOL, CREDENTIAL_STORE_OWN_CODES, PROVIDER_WIRE_VALUES, FAKE_PROVIDERS]));
    expect(scanned.flatMap((file) => unmistakableLines(read(file)).map((line) => `${file}:${line}`))).toEqual([]);
  });

  it('no literal or object key equal to retry, invalid_grant, confirmed or unconfirmed in the files that speak the plan API', () => {
    const scanned = productFiles().filter((file) => within(file, PLAN_SURFACES) && file !== PROVIDER_WIRE_VALUES);
    expect(scanned.length).toBeGreaterThan(PLAN_SURFACES.length);
    expect(scanned.flatMap((file) => everydayLines(read(file)).map((line) => `${file}:${line}`))).toEqual([]);
  });

  it('the scan refuses a quoted word, an object key, a case label and a template part, and not a constant name or a longer word', () => {
    expect(unmistakableLines("const state = 'store_unreadable';")).toEqual([1]);
    expect(unmistakableLines('const actions = { store_unwritable: 1 };')).toEqual([1]);
    expect(unmistakableLines("switch (outcome) {\n  case 'signed_in':\n    break;\n}")).toEqual([2]);
    expect(unmistakableLines('const text = `the state is plan_disabled now`;')).toEqual([1]);
    expect(unmistakableLines('const state = PLAN_STORE_UNREADABLE_STATE;\nconst code = `${PLAN_STORE_UNREADABLE_CODE}`;\nconst other = "plan_store_unreadable";')).toEqual([]);
    expect(everydayLines("return { outcome: 'retry', reason: 'invalid_grant' };")).toEqual([1]);
    expect(everydayLines("const phase = 'retrying';\nconst word = RETRY_OUTCOME;")).toEqual([]);
  });

  it('the provider\'s wire values file holds only the two OAuth error words the gateway compares', () => {
    expect(read(PROVIDER_WIRE_VALUES).match(/'[^']*'/g)).toEqual(["'invalid_grant'", "'access_denied'"]);
  });
});

describe('F23: the probing answer has one predicate and one status constant', () => {
  it('no package source outside protocol defines SERVICE_UNAVAILABLE_STATUS or isTargetProbing', () => {
    const own = productFiles().filter((file) => !within(file, [PROTOCOL]) && /\b(?:const|function)\s+(?:SERVICE_UNAVAILABLE_STATUS|isTargetProbing)\b/.test(read(file)));
    expect(own).toEqual([]);
  });
});
