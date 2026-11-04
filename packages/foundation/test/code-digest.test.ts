import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeDigestOfRunningProcess } from '@momonga/foundation';

const foundationSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'code-digest.ts');

const sha256Of = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('the code digest of the running process', () => {
  it('is the sha256 of the file the running process loaded it from, which in a source checkout is the foundation module itself', async () => {
    expect(await codeDigestOfRunningProcess()).toBe(sha256Of(foundationSource));
  });

  it('has one producer: the eval host no longer keeps its own copy', () => {
    const cliEvalCopy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'src', 'eval', 'code-digest.ts');
    expect(fs.existsSync(cliEvalCopy)).toBe(false);
  });
});
