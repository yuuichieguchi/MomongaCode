import { describe, expect, it } from 'vitest';
import { REDACTED_MARKER, createRedactor } from '@momonga/foundation';

describe('one redactor masks every form the product sends', () => {
  const redactor = createRedactor({ credentials: [] });

  it('masks a bearer value that holds no digit', () => {
    expect(redactor.whole('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toBe(`Authorization: Bearer ${REDACTED_MARKER}`);
  });

  it('masks a token field whose value holds only letters', () => {
    expect(redactor.whole('token=abcdefghijklmnopqrstuvwx')).toBe(`token=${REDACTED_MARKER}`);
  });

  it('masks the base64 form of a registered Basic credential wherever it appears', () => {
    const credential = 'proxyuser:hunter2-proxy-pass';
    const encoded = Buffer.from(credential, 'utf8').toString('base64');
    const holding = createRedactor({ credentials: [credential] });
    expect(holding.whole(`sent ${encoded} upstream`)).toBe(`sent ${REDACTED_MARKER} upstream`);
  });

  it('masks a registered credential in its URL-encoded form', () => {
    const credential = 'pa ss/word+mcp&9';
    const holding = createRedactor({ credentials: [credential] });
    expect(holding.whole(`GET /cb?code=${encodeURIComponent(credential)} failed`)).toBe(`GET /cb?code=${REDACTED_MARKER} failed`);
  });
});
