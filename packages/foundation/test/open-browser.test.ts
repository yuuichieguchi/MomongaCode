import { describe, expect, it } from 'vitest';
import { openCommandFor } from '../src/open-browser.ts';

const URL_TO_OPEN = new URL('https://auth.example.com/authorize?client_id=a&state=b');

describe('openCommandFor', () => {
  it('uses open on darwin and xdg-open on linux with the URL as one argument', () => {
    expect(openCommandFor('darwin', URL_TO_OPEN, {})).toEqual({ file: '/usr/bin/open', args: [URL_TO_OPEN.toString()] });
    expect(openCommandFor('linux', URL_TO_OPEN, {})).toEqual({ file: '/usr/bin/xdg-open', args: [URL_TO_OPEN.toString()] });
  });

  it('uses the url.dll file protocol handler on win32 so that & is not interpreted by a shell', () => {
    expect(openCommandFor('win32', URL_TO_OPEN, { SystemRoot: 'C:\\Windows' })).toEqual({
      file: 'C:\\Windows\\System32\\rundll32.exe',
      args: ['url.dll,FileProtocolHandler', URL_TO_OPEN.toString()],
    });
    expect(() => openCommandFor('win32', URL_TO_OPEN, {})).toThrow('SystemRoot');
  });

  it('rejects other platforms', () => {
    expect(() => openCommandFor('freebsd', URL_TO_OPEN, {})).toThrow('not supported');
  });
});
