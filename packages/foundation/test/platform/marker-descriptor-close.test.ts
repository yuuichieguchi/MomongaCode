import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UnregisteredDescriptorError, closeMarkerDescriptor, createMarker } from '../../src/platform/marker-file.ts';
import { fixedCapability } from '../support/probe-fakes.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';

describe('a marker descriptor is closed only through the registry that opened it', () => {
  it('refuses a number the registry does not own with a typed error and leaves it open', () => {
    const file = path.join(makeTemporaryDirectory(), 'foreign');
    const foreign = fs.openSync(file, 'w', 0o600);
    try {
      expect(() => closeMarkerDescriptor(foreign)).toThrow(UnregisteredDescriptorError);
      expect(fs.fstatSync(foreign).isFile()).toBe(true);
    } finally {
      fs.closeSync(foreign);
    }
  });

  it.for(['unenforced', 'proved'] as const)('closes a registered %s marker once and refuses the second close', async (answer) => {
    const handle = await createMarker(path.join(makeTemporaryDirectory(), 'marker'), { capability: fixedCapability(answer) });
    closeMarkerDescriptor(handle.fd);
    expect(() => fs.fstatSync(handle.fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    expect(() => closeMarkerDescriptor(handle.fd)).toThrow(UnregisteredDescriptorError);
  });
});
