import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { outputBoundOf } from '../src/worker/output-bound.ts';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const HELPER = path.join('worker', 'output-bound.ts');
const CALL_SITES = [path.join('worker', 'model-step.ts'), path.join('memory', 'reflection.ts'), path.join('worker', 'auto-classifier.ts')];

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : [];
  });

describe('the runtime sends an output bound through one helper (P2 item 4)', () => {
  it('returns no bound when the merged capability carries none, and the bound otherwise', () => {
    expect(outputBoundOf({ outputBoundField: 'none' }, 512)).toEqual({});
    expect(outputBoundOf({ outputBoundField: 'max_output_tokens' }, 512)).toEqual({ max_output_tokens: 512 });
    expect(outputBoundOf({}, 512)).toEqual({ max_output_tokens: 512 });
  });

  it('leaves no runtime source outside the helper writing max_output_tokens into a request body', () => {
    const writers = sourceFiles(SOURCE_ROOT)
      .filter((file) => /\bmax_output_tokens\s*:/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SOURCE_ROOT, file));
    expect(writers).toEqual([HELPER]);
    for (const site of CALL_SITES) expect(fs.readFileSync(path.join(SOURCE_ROOT, site), 'utf8')).toContain('outputBoundOf(');
  });
});
