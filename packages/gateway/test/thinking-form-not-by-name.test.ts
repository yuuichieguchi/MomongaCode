import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const anthropicDir = path.join(packagesDir, 'gateway', 'src', 'adapters', 'anthropic');

const scannedFiles = [
  ...fs
    .readdirSync(anthropicDir)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => path.relative(packagesDir, path.join(anthropicDir, name))),
  path.join('protocol', 'src', 'capabilities.ts'),
];

const MODEL_FAMILY_NAME = /claude|opus|sonnet|haiku/i;
const MODEL_ID_TEST = /\bmodel\b\s*(?:===|!==|==|!=|\.\s*(?:startsWith|endsWith|includes|match|search|indexOf)\s*\()|\.test\(\s*[\w.]*\bmodel\b/;

const sourceOf = (relative: string): string => fs.readFileSync(path.join(packagesDir, relative), 'utf8');

describe('the thinking form is never chosen from a model id', () => {
  it.for(scannedFiles)('%s names no model family', (relative) => {
    expect(sourceOf(relative)).not.toMatch(MODEL_FAMILY_NAME);
  });

  it.for(scannedFiles)('%s never compares or matches a model id', (relative) => {
    expect(sourceOf(relative)).not.toMatch(MODEL_ID_TEST);
  });
});
