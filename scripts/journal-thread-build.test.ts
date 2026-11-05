import path from 'node:path';
import type { BuildOptions } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundle, bundleJournalThread, repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const BUILD_TIMEOUT_MS = 300_000;
const PING_FIXTURE = `${repoRoot}test/fixtures/sea/journal-thread-ping.ts`;
const GENERATED_MODULE_RESOLVER = 'journal-thread-generated-module';

const recorded = vi.hoisted(() => [] as BuildOptions[]);

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>();
  return {
    ...actual,
    build: (options: BuildOptions) => {
      recorded.push(options);
      return actual.build(options);
    },
  };
});

const pluginNamesOf = (options: BuildOptions): string[] => (options.plugins ?? []).map((plugin) => plugin.name).sort();

describe('the journal thread bundle contents', () => {
  it(
    'carries neither undici nor any ata-validator file',
    async () => {
      const text = await bundleJournalThread();
      expect(text).not.toContain('node_modules/undici/');
      expect(text).not.toContain('ata-validator');
    },
    BUILD_TIMEOUT_MS,
  );
});

describe('the plugins of the two builds', () => {
  let root = '';

  beforeAll(() => {
    root = createTempRoot();
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  it(
    'builds the thread with the same plugins as the main bundle, apart from the resolver of the generated module',
    async () => {
      recorded.length = 0;
      await bundle({ entry: PING_FIXTURE, outfile: path.join(root, 'ping.mjs'), journalThreadModule: path.join(root, 'journal-thread-code.generated.ts') });
      const thread = recorded.filter((options) => options.format === 'cjs');
      const main = recorded.filter((options) => options.format === 'esm');
      expect(thread).toHaveLength(1);
      expect(main).toHaveLength(1);
      const threadNames = pluginNamesOf(thread[0] as BuildOptions);
      expect(threadNames).toContain('ata-validator-without-native-and-code-from-strings');
      expect(pluginNamesOf(main[0] as BuildOptions)).toEqual([...threadNames, GENERATED_MODULE_RESOLVER].sort());
    },
    BUILD_TIMEOUT_MS,
  );
});
