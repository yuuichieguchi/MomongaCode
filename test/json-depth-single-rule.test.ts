import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonDepthError, MAX_JSON_DEPTH, checkJsonDepth } from '@momonga/foundation';

const ROOT = path.resolve(import.meta.dirname, '..');

const sourceOf = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

const productSources = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => name !== 'testkit')
    .map((name) => path.join(ROOT, 'packages', name, 'src'))
    .filter((dir) => fs.existsSync(dir))
    .flatMap(sourceFiles);

const BOUNDARIES = [
  'packages/tools/src/validate.ts',
  'packages/runtime/src/service/request.ts',
  'packages/config/src/json-file.ts',
  'packages/eval/src/dataset.ts',
  'packages/mcp/src/input-requests.ts',
  'packages/mcp/src/connection.ts',
  'packages/foundation/src/canonical-json.ts',
];

const CONSTANT_DECLARATION = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*DEPTH[A-Z0-9_]*)\s*=\s*\d/g;

const UNRELATED_TO_JSON = new Set(['MAX_CAUSE_DEPTH']);

describe('one JSON depth rule for every value that enters from outside', () => {
  it('walks a value with the one foundation walk and refuses depth past the bound with the typed error', () => {
    let atBound: unknown = [];
    for (let level = 1; level < MAX_JSON_DEPTH; level += 1) atBound = [atBound];
    expect(() => checkJsonDepth(atBound)).not.toThrow();
    expect(() => checkJsonDepth([atBound])).toThrow(JsonDepthError);
  });

  it.each(BOUNDARIES)('%s checks depth through the one foundation walk', (file) => {
    const source = sourceOf(file);
    expect(source).toMatch(/\bcheckJsonDepth\(/);
    if (!file.startsWith('packages/foundation/')) expect(source).toMatch(/import \{[^}]*\bcheckJsonDepth\b[^}]*\} from '@momonga\/foundation'/);
  });

  it('declares no JSON depth constant other than the one in foundation', () => {
    const declared = productSources().flatMap((file) =>
      [...fs.readFileSync(file, 'utf8').matchAll(CONSTANT_DECLARATION)]
        .map((match) => match[1] as string)
        .filter((name) => !UNRELATED_TO_JSON.has(name))
        .map((name) => `${path.relative(ROOT, file)}:${name}`),
    );
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatch(/^packages\/foundation\/src\/[^:]+:MAX_JSON_DEPTH$/);
  });
});
