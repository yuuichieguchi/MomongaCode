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

  it('is imported from @momonga/foundation by the gateway and by the eval host', () => {
    const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const importsFromFoundation = (directory: string): boolean =>
      fs
        .readdirSync(path.join(packages, directory), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts'))
        .some((file) => /import \{[^}]*\bcodeDigestOfRunningProcess\b[^}]*\} from '@momonga\/foundation'/.test(fs.readFileSync(path.join(packages, directory, file), 'utf8')));
    expect(importsFromFoundation(path.join('gateway', 'src'))).toBe(true);
    expect(importsFromFoundation(path.join('cli', 'src', 'eval'))).toBe(true);
  });
});
