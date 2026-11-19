import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { packageSources, parseSource, parsedProductSource, relativeOf } from './support/source-scan.ts';
import type { ParsedSource } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const VIEW_BUILDERS = new Set([
  'packages/cli/src/client/gateway-client.ts',
  'packages/cli/src/commands/models.ts',
  'packages/cli/src/tui/models/add.ts',
  'packages/cli/src/eval/context-host.ts',
  'packages/cli/src/models-texts.ts',
]);

const ownNameReadsOf = (source: ParsedSource): string[] =>
  source.text
    .split('\n')
    .flatMap((line, index) => (/\bownName\b/.test(line) ? [`${relativeOf(source.file)}:${index + 1}`] : []));

describe('code that shows a model to a person reaches its name only through the display function', () => {
  it('finds a read of the own name in a member, a key or a quoted key', () => {
    expect(ownNameReadsOf(parseSource('sample.ts', "const a = entry.ownName;\nconst b = entry['ownName'];\nconst { ownName } = entry;"))).toEqual(expect.arrayContaining(['sample.ts:1', 'sample.ts:2', 'sample.ts:3']));
    expect(ownNameReadsOf(parseSource('sample.ts', 'const shown = displays.get(entry.id);'))).toEqual([]);
  });

  it('no person-facing source outside the files that build model views reads an own name', () => {
    const found = packageSources('cli')
      .filter((file) => !VIEW_BUILDERS.has(relativeOf(file)))
      .flatMap((file) => ownNameReadsOf(parsedProductSource(file)));
    expect(found).toEqual([]);
  });
});
