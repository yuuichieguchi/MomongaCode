import { describe, expect, it } from 'vitest';
import { MAX_REDACTED_CHARS, REDACTED_MARKER, createRedactor } from '@momonga/foundation';

const redactor = createRedactor({ credentials: [] });

describe('redactor in the foundation', () => {
  it('returns ordinary text below the cap unchanged', () => {
    const text = 'The deploy script lives in scripts/deploy.sh and needs the VPN.';
    expect(redactor.text(text)).toBe(text);
  });

  it('replaces a provider key without any registered credential', () => {
    const text = 'use sk-abcdefghijklmnopqrstuvwxyz0123456789 for it';
    expect(redactor.text(text)).toBe(`use ${REDACTED_MARKER} for it`);
  });

  it('only changes text beyond the cap by truncating it, so shorter text changes only when it holds a secret', () => {
    const long = 'a '.repeat(MAX_REDACTED_CHARS);
    expect(redactor.text(long).length).toBeLessThanOrEqual(MAX_REDACTED_CHARS);
    const half = 'a '.repeat(MAX_REDACTED_CHARS / 4);
    expect(redactor.text(half)).toBe(half);
  });
});

describe('credential fields inside JSON text', () => {
  const PASSWORD = 'Hunter2Hunter2Hunter2';

  it('redacts a field in plain JSON text', () => {
    expect(redactor.whole(`{"password":"${PASSWORD}"}`)).toBe(`{"password":"${REDACTED_MARKER}"}`);
  });

  it.each([1, 2, 3])('redacts the same field when the JSON text is itself a string escaped %i time(s)', (depth) => {
    let text = `{"password":"${PASSWORD}"}`;
    for (let level = 0; level < depth; level += 1) text = JSON.stringify(text).slice(1, -1);
    const output = redactor.whole(text);
    expect(output).not.toContain(PASSWORD);
    expect(output).toContain(REDACTED_MARKER);
  });

  it('redacts a field of a serialised event so that the parsed event holds no credential', () => {
    const event = { type: 'tool.completed', output: `{"password":"${PASSWORD}"}` };
    const parsed = JSON.parse(redactor.whole(JSON.stringify(event))) as typeof event;
    expect(parsed.output).toBe(`{"password":"${REDACTED_MARKER}"}`);
  });
});

describe('masked credentials versus ordinary text', () => {
  it.each([
    'char ***argv',
    'Section breaks use ***',
    '***bold italic***',
    '*****',
    'int ***p = NULL;',
  ])('keeps ordinary text %j unchanged', (input) => {
    expect(redactor.whole(input)).toBe(input);
  });

  it.each([
    ['sk-proj-****…5hQA', REDACTED_MARKER],
    ['abc1****wxyz', REDACTED_MARKER],
    ['****abcd', REDACTED_MARKER],
    ['ab****cd****ef', REDACTED_MARKER],
    ['key sk-proj-********************5hQA.', `key ${REDACTED_MARKER}.`],
  ])('redacts the masked credential %j', (input, expected) => {
    expect(redactor.whole(input)).toBe(expected);
  });
});
