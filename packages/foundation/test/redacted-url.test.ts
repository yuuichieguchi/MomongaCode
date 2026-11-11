import { describe, expect, it } from 'vitest';
import { redactedUrl } from '@momonga/foundation';

describe('redactedUrl shows only what identifies the server', () => {
  it.each([
    ['user:secret@proxy:8080', 'http://proxy:8080'],
    ['http://user:secret@proxy:8080/path?token=x', 'http://proxy:8080'],
    ['proxy.example:3128', 'http://proxy.example:3128'],
    ['https://api.example/v1/secret-path', 'https://api.example'],
    ['http://[::1]:11434/v1#frag', 'http://[::1]:11434'],
    ['socks5h://u:p@socks.example:1080', 'socks5h://socks.example:1080'],
  ])('%s is shown as %s', (raw, shown) => {
    expect(redactedUrl(raw)).toBe(shown);
  });

  it.each(['http://', 'http://exa mple:1/secret', 'file:///etc/secret', 'ftp://u:secret@host/x', ''])('%j gives the placeholder and never echoes the input', (raw) => {
    expect(redactedUrl(raw)).toBe('<unparseable URL>');
  });
});
