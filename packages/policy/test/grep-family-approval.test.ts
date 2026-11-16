import { describe, expect, it } from 'vitest';
import { commandSpecsFor } from '../src/platform-specs.ts';

describe.each(['darwin', 'linux'] as const)('grep family approval on %s', (platform) => {
  const { specOf } = commandSpecsFor(platform);

  it.each(['grep', 'egrep', 'fgrep'])('%s is read-only', (program) => {
    expect(specOf(program)?.approval).toBe('read-only');
  });
});
