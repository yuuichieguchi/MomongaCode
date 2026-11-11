import { describe, expect, it } from 'vitest';
import { markdownRows } from '../../src/tui/screen/markdown.ts';
import { linksOf, parseWebUrl, wrapLine } from '../../src/tui/screen/wrap.ts';

describe('the one reading of a web address', () => {
  it.each(['https://example.com/a', 'http://example.com', 'HTTPS://Example.com/a?b=c#d', 'http://[::1]:8080/x'])('reads %s', (text) => {
    expect(parseWebUrl(text)?.href).toBe(new URL(text).href);
  });

  it.each(['http://[', 'http://', 'https://exa mple.com', 'ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'example.com', ''])('reads no address in %j', (text) => {
    expect(parseWebUrl(text)).toBeUndefined();
  });
});

describe('links in wrapped text', () => {
  it('links a bare URL that parses', () => {
    expect(linksOf('see https://example.com/a now')).toEqual([[4, 25, 'https://example.com/a']]);
  });

  it('leaves text that starts like a URL and does not parse as plain text', () => {
    expect(linksOf('see http://[ now')).toEqual([]);
    expect(wrapLine('see http://[ now', 40).every((row) => row.links === undefined)).toBe(true);
  });

  it('links the URLs that parse beside one that does not', () => {
    expect(linksOf('http://[ https://example.com/a')).toEqual([[9, 30, 'https://example.com/a']]);
  });
});

describe('links in markdown', () => {
  it('links nothing for a markdown link or an autolink whose address does not parse', () => {
    const rows = markdownRows('[here](http://[) and <http://[>', 60);
    expect(rows.map((row) => row.text).join('')).toContain('http://[');
    expect(rows.every((row) => row.links === undefined)).toBe(true);
  });
});
