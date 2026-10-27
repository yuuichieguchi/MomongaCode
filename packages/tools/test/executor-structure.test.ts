import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = path.resolve(import.meta.dirname, '../src');
const sourceOf = (file: string): string => fs.readFileSync(path.join(srcDir, file), 'utf8');

describe('the executor reads the one compilation and the one validation', () => {
  it('never compiles file rules a second time', () => {
    expect(sourceOf('executor.ts')).not.toMatch(/\bcomputeFileRules\b/);
  });

  it.each(['executor.ts', 'read-access.ts'])('%s does not re-validate the sandbox policy', (file) => {
    expect(sourceOf(file)).not.toMatch(/\b(assertAbsoluteEntries|assertReadAllowedValid|assertSessionTmpDirValid)\b/);
  });
});
