import { describe, expect, it } from 'vitest';
import { hasSocketGuard } from '../../src/platform/socket-guard-platform.ts';

describe('the platforms that have a socket guard', () => {
  it('is linux only, read through the platform adapter', () => {
    expect([hasSocketGuard('linux'), hasSocketGuard('darwin'), hasSocketGuard('win32')]).toEqual([true, false, false]);
  });
});
