import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORD_LIST, MIN_HIDDEN_CREDENTIAL_CHARS, judgeCredential } from '../src/credential-strength.ts';

describe('judgeCredential against the pinned common-password list (NIST SP 800-63B 5.1.1.2)', () => {
  it('pins the list it checks against by source and version', () => {
    expect(COMMON_PASSWORD_LIST.source).toMatch(/\S/);
    expect(COMMON_PASSWORD_LIST.version).toMatch(/\S/);
    expect(COMMON_PASSWORD_LIST.size).toBeGreaterThan(1000);
  });

  it('hides values of at least 8 characters', () => {
    expect(MIN_HIDDEN_CREDENTIAL_CHARS).toBe(8);
  });

  it.each(['password', '12345678', 'qwerty123', 'iloveyou'])('judges %s common and long enough', (value) => {
    expect(judgeCredential(value)).toEqual({ common: true, short: false });
  });

  it('judges a long passphrase outside the list neither common nor short', () => {
    expect(judgeCredential('correct-horse-battery-staple-7f')).toEqual({ common: false, short: false });
  });

  it('judges a 7-character value outside the list short only', () => {
    expect(judgeCredential('Zq7#vK2')).toEqual({ common: false, short: true });
  });

  it('judges an 8-character value outside the list not short', () => {
    expect(judgeCredential('Zq7#vK2m')).toEqual({ common: false, short: false });
  });

  it('judges a short common value both common and short', () => {
    expect(judgeCredential('123456')).toEqual({ common: true, short: true });
  });
});
