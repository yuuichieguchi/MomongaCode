import { describe, expect, it } from 'vitest';
import { isTransientErrno } from '@momonga/foundation';

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

describe('isTransientErrno', () => {
  it.each(['EMFILE', 'ENFILE', 'EIO', 'EAGAIN', 'EBUSY', 'ENOMEM', 'EINTR', 'ETIMEDOUT', 'ENOSPC', 'EDQUOT'])('is true for %s', (code) => {
    expect(isTransientErrno(errnoError(code))).toBe(true);
  });

  it.each(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'])('is false for %s', (code) => {
    expect(isTransientErrno(errnoError(code))).toBe(false);
  });

  it('is false for a non-Error value and for an error without a code', () => {
    expect(isTransientErrno({ code: 'EMFILE' })).toBe(false);
    expect(isTransientErrno('EMFILE')).toBe(false);
    expect(isTransientErrno(undefined)).toBe(false);
    expect(isTransientErrno(new Error('EMFILE'))).toBe(false);
  });
});
