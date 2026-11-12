import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const DEFINITION = 'packages/protocol/src/model-ref.ts';
const REEXPORT = 'packages/protocol/src/index.ts';

const TYPED_CALLERS: readonly string[] = [
  'packages/config/src/models.ts',
  'packages/config/src/models-writers.ts',
  'packages/gateway/src/core/router.ts',
  'packages/runtime/src/service/app.ts',
  'packages/runtime/src/process/child-runs.ts',
  'packages/runtime/src/worker/auto-classifier.ts',
  'packages/cli/src/commands/gateway.ts',
  'packages/cli/src/commands/auto-mode.ts',
  'packages/cli/src/commands/models.ts',
  'packages/cli/src/commands/evaluate.ts',
  'packages/cli/src/commands/context.ts',
  'packages/cli/src/eval/context-host.ts',
  'packages/cli/src/tui/commands/models.ts',
  'packages/cli/src/acp/models.ts',
];

const TYPED_TOKENS = ['resolveTypedModelRef', 'typedModelText('] as const;
const CAST_TO_TYPED = /as\s+(unknown\s+as\s+)?TypedModelText\b/;

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const sources = (): { file: string; text: string }[] =>
  fs
    .readdirSync(packagesDir)
    .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
    .flatMap((name) => filesUnder(path.join(packagesDir, name, 'src')))
    .map((full) => ({ file: path.relative(root, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') }));

describe('a stored reference never reaches the resolver of typed text (I-N15)', () => {
  it('resolveTypedModelRef and typedModelText are named only by their definition and by the callers that take text from a person', () => {
    const holders = sources()
      .filter((source) => TYPED_TOKENS.some((token) => source.text.includes(token)))
      .map((source) => source.file);
    expect(holders).toContain(DEFINITION);
    expect(holders.filter((file) => file !== DEFINITION && file !== REEXPORT && !TYPED_CALLERS.includes(file))).toEqual([]);
  });

  it('no source outside the definition casts a value to TypedModelText', () => {
    const all = sources();
    expect(all.find((source) => source.file === DEFINITION)?.text ?? '').toContain('typedBrand');
    expect(all.filter((source) => source.file !== DEFINITION && CAST_TO_TYPED.test(source.text)).map((source) => source.file)).toEqual([]);
  });
});
