import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const adaptersDir = path.join(packagesDir, 'gateway', 'src', 'adapters');

const ADAPTERS_THAT_RENDER_SAMPLING = ['anthropic', 'chat-completions', 'open-responses', 'ollama', 'shared'];

const sourcesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [path.relative(packagesDir, full)] : [];
  });

const scannedFiles = [
  ...ADAPTERS_THAT_RENDER_SAMPLING.flatMap((adapter) => sourcesUnder(path.join(adaptersDir, adapter))),
  path.join('gateway', 'src', 'core', 'respond.ts'),
  path.join('protocol', 'src', 'capabilities.ts'),
  path.join('config', 'src', 'settings-schema.ts'),
];

const MODEL_FAMILY_NAME = /claude|opus|sonnet|haiku|fable/i;
const MODEL_ID_TEST = /\bmodel\b\s*(?:===|!==|==|!=|\.\s*(?:startsWith|endsWith|includes|match|search|indexOf)\s*\()|\.test\(\s*[\w.]*\bmodel\b/;

const sourceOf = (relative: string): string => fs.readFileSync(path.join(packagesDir, relative), 'utf8');

describe('sampling acceptance is never decided from a model id', () => {
  it.for(scannedFiles)('%s names no model family', (relative) => {
    expect(sourceOf(relative)).not.toMatch(MODEL_FAMILY_NAME);
  });

  it.for(scannedFiles)('%s never compares or matches a model id', (relative) => {
    expect(sourceOf(relative)).not.toMatch(MODEL_ID_TEST);
  });
});
