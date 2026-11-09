import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMarker } from '../../src/platform/marker-file.ts';
import { fixedCapability } from '../support/probe-fakes.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';

describe('T17 createMarker writes the empty attempt record (decision 12: "createMarker (3F) writes r00000 and a newline in the same open that creates and locks the file")', () => {
  it.for(['unenforced', 'proved'] as const)('on a %s directory the new marker reads r00000 and a newline', async (answer) => {
    const marker = path.join(makeTemporaryDirectory(), 'marker');
    const handle = await createMarker(marker, { capability: fixedCapability(answer) });
    handle.close();
    expect(fs.readFileSync(marker, 'utf8')).toBe('r00000\n');
  });
});
