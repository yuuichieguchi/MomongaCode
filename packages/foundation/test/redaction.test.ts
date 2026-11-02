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
