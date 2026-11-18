import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { directoryFlag, directoryFlagOf, noFollowFlag, noFollowFlagOf } from '../../src/platform/privacy.ts';

describe('the open flags come from the flags the host offers, never from the platform name (B16)', () => {
  it('uses O_NOFOLLOW and O_DIRECTORY when the host offers them', () => {
    expect(noFollowFlagOf({ O_NOFOLLOW: 0x100, O_DIRECTORY: 0x200 })).toBe(0x100);
    expect(directoryFlagOf({ O_NOFOLLOW: 0x100, O_DIRECTORY: 0x200 })).toBe(0x200);
  });

  it('adds no flag that the host does not offer', () => {
    expect(noFollowFlagOf({})).toBe(0);
    expect(directoryFlagOf({})).toBe(0);
  });

  it('reads the host flags from fs.constants', () => {
    expect(noFollowFlag()).toBe(fs.constants.O_NOFOLLOW ?? 0);
    expect(directoryFlag()).toBe(fs.constants.O_DIRECTORY ?? 0);
  });
});
