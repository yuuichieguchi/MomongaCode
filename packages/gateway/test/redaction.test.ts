import { describe, expect, it, vi } from 'vitest';
import { JSON_OBJECT_UNSUPPORTED_MESSAGE } from '@momonga/testkit';
import { createRedactor } from '../src/core/redaction.ts';
import { REDACTED, SK, TEST_API_KEY, expectNoCredential } from './credential-support.ts';

const CAP = 1024;
const SUFFIX = ' …[truncated]';
const KEEP = CAP - SUFFIX.length;
const KIB_64 = 64 * 1024;

const redactor = createRedactor({ credentials: [TEST_API_KEY] });
const text = (input: string): string => redactor.text(input);

const AIZA = 'AI' + 'za';
const PROVIDER_PREFIXES = ['gsk' + '_', 'xai' + '-', 'hf' + '_', 'pplx' + '-', 'nvapi' + '-'] as const;
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NSJ9', 'c2lnbmF0dXJlMTIz'].join('.');
const BEARER = 'Bearer' + ' ';
const BASIC = 'Basic' + ' ';
const BASIC_VALUE = ['dXNlcjpwYXNz', 'd29yZDEyMw=='].join('');
const HEADER_VALUE = ['abcd1234', 'efgh5678', 'ijkl'].join('');
const PASSWORD_VALUE = ['Sup3r', 'S3cret', 'Value99'].join('');
const FIELD_VALUE = ['abcdef01', '23456789', 'abcd'].join('');

type Case = { name: string; input: string; expected: string };

const maskedCases: Case[] = [
  { name: 'project key masked with stars and an ellipsis', input: `${SK}proj-****…5hQA`, expected: REDACTED },
  { name: 'project key masked with three dots', input: `${SK}proj-abc...wxyz`, expected: REDACTED },
  { name: 'project key abbreviated with one ellipsis', input: `${SK}proj-abcd1234…5hQA`, expected: REDACTED },
  { name: 'bare prefix masked with dots', input: `${SK}...5hQA`, expected: REDACTED },
  { name: 'unknown prefix masked with stars', input: 'abc1****wxyz', expected: REDACTED },
  { name: 'stars then suffix', input: '****abcd', expected: REDACTED },
  { name: 'two mask groups', input: 'ab****cd****ef', expected: REDACTED },
  { name: 'a 70-letter prefix before the mask', input: `${'a'.repeat(70)}****wxyz`, expected: REDACTED },
  { name: 'suffix with a dash and a digit', input: `${SK}proj-****Ab-9`, expected: REDACTED },
  {
    name: "OpenAI's 401 echo of a masked key",
    input: `Incorrect API key provided: ${SK}proj-${'*'.repeat(20)}5hQA. You can find your API key at https://platform.openai.com/account/api-keys.`,
    expected: `Incorrect API key provided: ${REDACTED}. You can find your API key at https://platform.openai.com/account/api-keys.`,
  },
];

const fullShapeCases: Case[] = [
  { name: 'PA: a plain sk- key', input: `use ${SK}abcdefgh12345678 now`, expected: `use ${REDACTED} now` },
  { name: 'PA: an Anthropic key', input: `key ${SK}ant-api03-AbCdEf0123456789 rejected`, expected: `key ${REDACTED} rejected` },
  { name: 'PA: an OpenRouter key', input: `(${SK}or-v1-0123456789abcdef)`, expected: `(${REDACTED})` },
  { name: 'PB: a Google key', input: `got ${AIZA}${'b1'.repeat(17)}c end`, expected: `got ${REDACTED} end` },
  ...PROVIDER_PREFIXES.map((prefix) => ({
    name: `PB: a ${prefix} key`,
    input: `value ${prefix}${'a1'.repeat(10)} end`,
    expected: `value ${REDACTED} end`,
  })),
  {
    name: 'PC: a JWT bearer token',
    input: `Authorization: ${BEARER}${JWT}`,
    expected: `Authorization: ${BEARER}${REDACTED}`,
  },
  { name: 'PC: a basic credential', input: `header ${BASIC}${BASIC_VALUE} sent`, expected: `header ${BASIC}${REDACTED} sent` },
  { name: 'PD: an x-api-key JSON field', input: `{"x-api-key": "${HEADER_VALUE}"}`, expected: `{"x-api-key": "${REDACTED}"}` },
  { name: 'PD: a password assignment', input: `password=${PASSWORD_VALUE}`, expected: `password=${REDACTED}` },
  { name: 'PD: an api_key field', input: `api_key: ${FIELD_VALUE}`, expected: `api_key: ${REDACTED}` },
];

const acceptedCases: Case[] = [
  { name: 'identifier with a known prefix cut by an ellipsis', input: "model 'xai-grok…' not found", expected: `model '${REDACTED}' not found` },
  { name: 'sk-learn followed by dots in prose', input: 'sk-learn... docs', expected: `${REDACTED} docs` },
  { name: 'hf_hub followed by dots', input: 'hf_hub...', expected: REDACTED },
  { name: 'sk-learn followed by an ellipsis', input: 'sk-learn…', expected: REDACTED },
];

const keptTexts: string[] = [
  'a valid bearer token is required',
  JSON_OBJECT_UNSUPPORTED_MESSAGE,
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
  'max_tokens: 4096',
  'tokens: 128000',
  'token limit exceeded',
  'Bearer authentication is required',
  'invalid_api_key',
  'request id req_0123456789abcdef0123',
  'bad schema',
  'e3',
  'sk-learn',
  'Loading...done',
  'wait...',
  '**bold**',
  '***bold***',
  '***',
  '*****',
  'char ***argv',
  'abcd...wxyz',
  'Incorrect API key provided: AbCd…0123',
  `already ${REDACTED} here`,
  `cut short${SUFFIX}`,
];

const exactCases: Case[] = [
  {
    name: 'the raw value',
    input: `Incorrect API key provided: ${TEST_API_KEY}.`,
    expected: `Incorrect API key provided: ${REDACTED}.`,
  },
];

describe('redactor.text patterns', () => {
  it.for(maskedCases)('PM redacts $name as one marker and leaves no suffix', ({ input, expected }) => {
    const output = text(input);
    expect(output).toBe(expected);
    for (const suffix of ['5hQA', 'wxyz', 'abcd', 'Ab-9', 'cd', 'ef', 'bold']) {
      if (!expected.includes(suffix)) expect(output).not.toContain(suffix);
    }
  });

  it.for(fullShapeCases)('$name is redacted', ({ input, expected }) => {
    expect(text(input)).toBe(expected);
  });

  it.for(acceptedCases)('accepted false positive: $name is redacted', ({ input, expected }) => {
    expect(text(input)).toBe(expected);
  });

  it.for(keptTexts)('keeps %s unchanged', (input) => {
    expect(text(input)).toBe(input);
  });
});

describe('redactor.text exact values', () => {
  it.for(exactCases)('redacts $name', ({ input, expected }) => {
    expect(text(input)).toBe(expected);
  });

  it('redacts the JSON-string-escaped form of a value', () => {
    const credential = 'pa"ss\\word-123';
    const escaped = JSON.stringify(credential).slice(1, -1);
    expect(escaped).toBe('pa\\"ss\\\\word-123');
    const local = createRedactor({ credentials: [credential] });
    expect(local.text(`{"message":"bad ${escaped}"}`)).toBe(`{"message":"bad ${REDACTED}"}`);
    expect(local.text(`raw ${credential} end`)).toBe(`raw ${REDACTED} end`);
  });

  it('redacts the percent-encoded form of a value', () => {
    const credential = 'abc def/ghi+jk';
    const local = createRedactor({ credentials: [credential] });
    expect(local.text('see abc%20def%2Fghi%2Bjk end')).toBe(`see ${REDACTED} end`);
  });

  it('redacts the trimmed form of a value configured with surrounding whitespace', () => {
    const local = createRedactor({ credentials: [`  ${TEST_API_KEY}\n`] });
    expect(local.text(`Incorrect API key provided: ${TEST_API_KEY}`)).toBe(`Incorrect API key provided: ${REDACTED}`);
  });

  it('prefers the longest value when one key is a prefix of another', () => {
    const local = createRedactor({ credentials: ['momonga-test', TEST_API_KEY] });
    expect(local.text(`x ${TEST_API_KEY} y`)).toBe(`x ${REDACTED} y`);
    expect(local.text('x momonga-test y')).toBe(`x ${REDACTED} y`);
  });

  it('ignores values shorter than 8 characters after trimming', () => {
    expect(createRedactor({ credentials: ['abcdefg'] }).text('abcdefg is here')).toBe('abcdefg is here');
    expect(createRedactor({ credentials: ['  abcdefg  '] }).text('abcdefg is here')).toBe('abcdefg is here');
    expect(createRedactor({ credentials: ['abcdefgh'] }).text('abcdefgh is here')).toBe(`${REDACTED} is here`);
  });

  it('matches case-sensitively', () => {
    expect(text(TEST_API_KEY.toUpperCase())).toBe(TEST_API_KEY.toUpperCase());
  });

  it('matches no prefix or suffix of a configured value', () => {
    expect(text('momonga-test-api-ke')).toBe('momonga-test-api-ke');
    expect(text('omonga-test-api-key')).toBe('omonga-test-api-key');
  });
});

describe('redactor.text cap', () => {
  it('leaves a text of 1024 characters unchanged', () => {
    const input = 'x'.repeat(CAP);
    expect(text(input)).toBe(input);
  });

  it('cuts a text of 1025 characters to 1024 with the suffix inside the cap', () => {
    expect(text('x'.repeat(CAP + 1))).toBe(`${'x'.repeat(KEEP)}${SUFFIX}`);
  });

  it('bounds a 64 KiB JSON message to 1024 characters in total', () => {
    const message = JSON.stringify({ error: { message: 'y'.repeat(KIB_64) } });
    const output = text(message);
    expect(output.length).toBeLessThanOrEqual(CAP);
    expect(output.endsWith(SUFFIX)).toBe(true);
    expect(output.startsWith('{"error":{"message":"yyy')).toBe(true);
  });

  it('redacts a key that straddles position 1020 before cutting', () => {
    const input = `${'x'.repeat(1001)}${TEST_API_KEY}${'x'.repeat(100)}`;
    const output = text(input);
    expect(output).toBe(`${'x'.repeat(1001)}${REDACTED}${SUFFIX}`);
    expectNoCredential(output, TEST_API_KEY);
  });

  it('never splits a surrogate pair at the cut', () => {
    const output = text(`${'x'.repeat(KEEP - 1)}😀${'x'.repeat(100)}`);
    expect(output).toBe(`${'x'.repeat(KEEP - 1)}${SUFFIX}`);
    expect(output.isWellFormed()).toBe(true);
  });
});

const idempotenceInputs: string[] = [
  ...maskedCases.map((entry) => entry.input),
  ...fullShapeCases.map((entry) => entry.input),
  ...acceptedCases.map((entry) => entry.input),
  ...keptTexts,
  ...exactCases.map((entry) => entry.input),
  'x'.repeat(KIB_64),
  'x'.repeat(CAP + 1),
  `${'x'.repeat(1001)}${TEST_API_KEY}${'x'.repeat(100)}`,
  `${'x'.repeat(KEEP - 1)}😀${'x'.repeat(100)}`,
  `${'*'.repeat(2000)} tail`,
  `${REDACTED} and ${REDACTED}${SUFFIX}`,
];

describe('redactor.text idempotence', () => {
  it.for(idempotenceInputs.map((input, index) => ({ index, input })))('text(text(x)) equals text(x) for case $index', ({ input }) => {
    const once = text(input);
    expect(text(once)).toBe(once);
  });
});

const fill = (unit: string, length = KIB_64): string => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

const engineCallsOf = (input: string): number => {
  const nativeExec = RegExp.prototype.exec;
  let calls = 0;
  const spy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, subject: string) {
    calls += 1;
    return nativeExec.call(this, subject);
  });
  try {
    text(input);
  } finally {
    spy.mockRestore();
  }
  return calls;
};

const SHORTEST_MATCH_CHARS = 3;
const PATTERNS_RUN_PER_REDACTION = 6;

type Adversarial = { name: string; build: (length: number) => string };

const pdCases: Adversarial[] = [
  { name: 'PD: key then a run of spaces', build: (length) => `key${' '.repeat(length)}` },
  { name: 'PD: key then a run of colons', build: (length) => `key${':'.repeat(length)}` },
  { name: 'PD: "key: " repeated', build: (length) => fill('key: ', length) },
  { name: 'PD: key: then letters only', build: (length) => `key:${'a'.repeat(length)}` },
  { name: 'PD: key: then digits only', build: (length) => `key:${'1'.repeat(length)}` },
];

const pcCases: Adversarial[] = [
  { name: 'PC: Bearer then letters only', build: (length) => `Bearer ${'a'.repeat(length)}` },
  { name: 'PC: Bearer then digits only', build: (length) => `Bearer ${'1'.repeat(length)}` },
];

const pmCases: Adversarial[] = [
  { name: 'PM: a run of stars', build: (length) => '*'.repeat(length) },
  { name: 'PM: a run of ellipses', build: (length) => '…'.repeat(length) },
  { name: 'PM: a run of dots', build: (length) => '.'.repeat(length) },
  { name: 'PM: sk- then dots', build: (length) => `${SK}${'.'.repeat(length)}` },
  { name: 'PM: sk- then letters', build: (length) => `${SK}${'a'.repeat(length)}` },
  { name: 'PM: a*** repeated', build: (length) => fill('a***', length) },
  { name: 'PM: sk-a... repeated', build: (length) => fill(`${SK}a...`, length) },
  { name: 'PM: 100 letters and ** repeated', build: (length) => fill(`${'a'.repeat(100)}**`, length) },
  { name: 'PM: sk- repeated', build: (length) => fill(SK, length) },
];

const paPbCases: Adversarial[] = [
  { name: 'PA/PB: an alphanumeric run', build: (length) => fill('aB3', length) },
  { name: 'PA/PB: sk- before an alphanumeric run', build: (length) => `${SK}${fill('aB3', length)}` },
  { name: 'PA/PB: AIza before an alphanumeric run', build: (length) => `${AIZA}${fill('aB3', length)}` },
];

describe('redactor.text stays linear on adversarial input', () => {
  it.for([...pdCases, ...pcCases, ...pmCases, ...paPbCases])('$name never asks the regex engine for more than one match per three characters on 64 KiB', ({ build }) => {
    const calls = engineCallsOf(build(KIB_64));
    expect(calls).toBeGreaterThanOrEqual(PATTERNS_RUN_PER_REDACTION);
    expect(calls).toBeLessThanOrEqual(PATTERNS_RUN_PER_REDACTION + KIB_64 / SHORTEST_MATCH_CHARS);
  });

  it.for([...pdCases, ...pcCases, ...pmCases, ...paPbCases])('$name doubles its engine calls at most when the input doubles', ({ build }) => {
    const half = engineCallsOf(build(KIB_64 / 2));
    const full = engineCallsOf(build(KIB_64));
    expect(full).toBeLessThanOrEqual(2 * half);
  });
});
