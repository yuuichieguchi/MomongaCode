import fs from 'node:fs';
import path from 'node:path';
import type { BuildOptions, Metafile } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundle, bundleJournalThread, journalThreadEntry, repoRoot } from './bundle.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

const PING_FIXTURE = `${repoRoot}test/fixtures/sea/journal-thread-ping.ts`;
const GENERATED_MODULE_RESOLVER = 'journal-thread-generated-module';

const recorded = vi.hoisted(() => [] as BuildOptions[]);
const metafiles = vi.hoisted(() => [] as Metafile[]);

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>();
  return {
    ...actual,
    build: async (options: BuildOptions) => {
      recorded.push(options);
      const result = await actual.build({ ...options, metafile: true });
      metafiles.push(result.metafile);
      return result;
    },
  };
});

const pluginNamesOf = (options: BuildOptions): string[] => (options.plugins ?? []).map((plugin) => plugin.name).sort();

const packageDirectoryOf = (name: string): string => `${fs.realpathSync(path.join(repoRoot, 'node_modules', name))}${path.sep}`;

const filesCarriedBy = (metafile: Metafile): string[] =>
  Object.values(metafile.outputs)
    .flatMap((output) => Object.entries(output.inputs))
    .filter(([, contribution]) => contribution.bytesInOutput > 0)
    .map(([input]) => fs.realpathSync(path.resolve(repoRoot, input)));

describe('the journal thread bundle contents', () => {
  it(
    'carries neither undici nor any ata-validator file',
    async () => {
      metafiles.length = 0;
      await bundleJournalThread();
      expect(metafiles).toHaveLength(1);
      const files = filesCarriedBy(metafiles[0] as Metafile);
      expect(files).toContain(fs.realpathSync(journalThreadEntry));
      for (const excluded of [packageDirectoryOf('undici'), packageDirectoryOf('@momonga/ata-validator')]) {
        expect(files.filter((file) => file.startsWith(excluded))).toEqual([]);
      }
    },
    UNBOUNDED_BUILD_WAIT_MS,
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
    UNBOUNDED_BUILD_WAIT_MS,
  );
});
