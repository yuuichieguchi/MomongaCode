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

describe('keyed values of the redactor', () => {
  const FIRST = 'rotating-aa1';
  const SECOND = 'rotating-bb2';

  it('set replaces the values of its key: the old value is no longer redacted, the new one is', () => {
    const keyed = createRedactor({ credentials: [] });
    keyed.set('plan/chatgpt/work', [FIRST]);
    expect(keyed.text(`a ${FIRST} b`)).toBe(`a ${REDACTED_MARKER} b`);
    keyed.set('plan/chatgpt/work', [SECOND]);
    expect(keyed.text(`a ${FIRST} b`)).toBe(`a ${FIRST} b`);
    expect(keyed.text(`a ${SECOND} b`)).toBe(`a ${REDACTED_MARKER} b`);
  });

  it('a value held by add stays redacted when a key drops it', () => {
    const keyed = createRedactor({ credentials: [] });
    keyed.add(FIRST);
    keyed.set('plan/chatgpt/work', [FIRST]);
    keyed.set('plan/chatgpt/work', [SECOND]);
    expect(keyed.text(`a ${FIRST} b`)).toBe(`a ${REDACTED_MARKER} b`);
  });

  it('set with an empty list removes the key', () => {
    const keyed = createRedactor({ credentials: [] });
    keyed.set('plan/chatgpt/work', [FIRST]);
    keyed.set('plan/chatgpt/work', []);
    expect(keyed.text(`a ${FIRST} b`)).toBe(`a ${FIRST} b`);
  });

  it('2000 rotations through one key leave only the last list redacted', () => {
    const keyed = createRedactor({ credentials: [] });
    const tokenOf = (index: number): string => `rotation-${String(index).padStart(6, '0')}`;
    for (let index = 0; index < 2000; index += 1) keyed.set('k', [tokenOf(index)]);
    expect(keyed.text(`x ${tokenOf(0)} y`)).toBe(`x ${tokenOf(0)} y`);
    expect(keyed.text(`x ${tokenOf(1999)} y`)).toBe(`x ${REDACTED_MARKER} y`);
  });

  it('add of an already held value changes nothing', () => {
    const keyed = createRedactor({ credentials: [] });
    for (let index = 0; index < 5000; index += 1) keyed.add(FIRST);
    const filler = 'z'.repeat(1024 * 1024);
    const output = keyed.whole(`${filler}${FIRST}${filler}`);
    expect(output).toBe(`${filler}${REDACTED_MARKER}${filler}`);
  });
});
