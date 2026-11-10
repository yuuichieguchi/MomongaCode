import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

const sourceOf = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : [];
  });

const productSources = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'packages'))
    .map((name) => path.join(ROOT, 'packages', name, 'src'))
    .filter((dir) => fs.existsSync(dir))
    .flatMap(sourceFiles);

const DECLARATION = /\b(?:const|let|var)\s+AUTH_DOCUMENT_MAX_BYTES\s*=/g;

describe('the 256 KiB auth document cap has one source (O-R5-6 J 8)', () => {
  it('is declared once, as AUTH_DOCUMENT_MAX_BYTES = 256 * 1024 in foundation credential-store.ts, and foundation exports it', () => {
    const declared = productSources().flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(DECLARATION)].map(() => path.relative(ROOT, file)));
    expect(declared).toEqual(['packages/foundation/src/credential-store.ts']);
    expect(sourceOf('packages/foundation/src/credential-store.ts')).toMatch(/export const AUTH_DOCUMENT_MAX_BYTES = 256 \* 1024;/);
    expect(sourceOf('packages/foundation/src/index.ts')).toMatch(/export \{[^}]*\bAUTH_DOCUMENT_MAX_BYTES\b[^}]*\} from '\.\/credential-store\.ts'/);
  });

  it('is the bound of the encrypted credential store', () => {
    const source = sourceOf('packages/foundation/src/encrypted-credential-store.ts');
    expect(source).toMatch(/import \{[^}]*\bAUTH_DOCUMENT_MAX_BYTES\b[^}]*\} from '\.\/credential-store\.ts'/);
    expect(source).toMatch(/readOwnerOnlyTextFile\([^)]*\bAUTH_DOCUMENT_MAX_BYTES\)/);
  });

  it('sets PLAN_SIGN_IN_DEFAULTS.authBodyBytes in the gateway', () => {
    const source = sourceOf('packages/gateway/src/defaults.ts');
    expect(source).toMatch(/import \{[^}]*\bAUTH_DOCUMENT_MAX_BYTES\b[^}]*\} from '@momonga\/foundation'/);
    expect(source).toMatch(/\bauthBodyBytes: AUTH_DOCUMENT_MAX_BYTES\b/);
  });

  it('leaves no CREDENTIAL_RECORD_MAX_BYTES in any product source', () => {
    const naming = productSources().filter((file) => fs.readFileSync(file, 'utf8').includes('CREDENTIAL_RECORD_MAX_BYTES')).map((file) => path.relative(ROOT, file));
    expect(naming).toEqual([]);
  });
});
