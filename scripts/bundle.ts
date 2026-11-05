import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO_PATTERN, RELEASE_PUBLIC_KEY_PATTERN, TEAM_ID_PATTERN } from '../packages/cli/src/update/source.ts';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const defaultEntry = `${repoRoot}packages/cli/src/main.ts`;
export const defaultOutfile = `${repoRoot}packages/cli/dist/main.js`;
export const journalThreadEntry = `${repoRoot}packages/runtime/src/memory/journal-thread.ts`;
export const journalThreadModule = `${repoRoot}packages/runtime/src/memory/journal-thread-code.generated.ts`;

export type UpdateSourceInputs = {
  readonly releaseRepo?: string;
  readonly teamId?: string;
  readonly releasePublicKey?: string;
};

export type BundleOptions = UpdateSourceInputs & {
  readonly entry: string;
  readonly outfile: string;
  readonly journalThreadModule?: string;
};

export const updateSourceDefines = ({ releaseRepo, teamId, releasePublicKey }: UpdateSourceInputs): Record<string, string> => {
  if (releaseRepo !== undefined && !REPO_PATTERN.test(releaseRepo)) throw new Error(`--repo must be <owner>/<repo>, got ${JSON.stringify(releaseRepo)}`);
  if (teamId !== undefined && !TEAM_ID_PATTERN.test(teamId)) throw new Error(`--team-id must be a 10-character Apple Team ID, got ${JSON.stringify(teamId)}`);
  if (releasePublicKey !== undefined && !RELEASE_PUBLIC_KEY_PATTERN.test(releasePublicKey)) {
    throw new Error(`--release-public-key must be one ssh public key line, got ${JSON.stringify(releasePublicKey)}`);
  }
  return {
    ...(releaseRepo === undefined ? {} : { __MOMONGA_RELEASE_REPO__: JSON.stringify(releaseRepo) }),
    ...(teamId === undefined ? {} : { __MOMONGA_TEAM_ID__: JSON.stringify(teamId) }),
    ...(releasePublicKey === undefined ? {} : { __MOMONGA_RELEASE_PUBLIC_KEY__: JSON.stringify(releasePublicKey) }),
  };
};

export const bundleJournalThread = async (): Promise<string> => {
  const result = await build({
    entryPoints: [journalThreadEntry],
    absWorkingDir: repoRoot,
    write: false,
    outdir: `${repoRoot}.cache/journal-thread-out`,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    bundle: true,
    legalComments: 'none',
    logLevel: 'error',
  });
  const [output, ...rest] = result.outputFiles;
  if (output === undefined || rest.length > 0) throw new Error(`journal thread bundle produced ${result.outputFiles.length} files, expected 1`);
  return output.text;
};

export const writeJournalThreadModule = async (modulePath: string = journalThreadModule): Promise<void> => {
  const code = await bundleJournalThread();
  const temporary = path.join(path.dirname(modulePath), `.${path.basename(modulePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `export const JOURNAL_THREAD_CODE = ${JSON.stringify(code)};\n`);
    fs.renameSync(temporary, modulePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
};

export const bundle = async ({ entry, outfile, releaseRepo, teamId, releasePublicKey, journalThreadModule: generatedModule = journalThreadModule }: BundleOptions): Promise<void> => {
  await writeJournalThreadModule(generatedModule);
  await build({
    entryPoints: [entry],
    outfile,
    define: updateSourceDefines({
      ...(releaseRepo === undefined ? {} : { releaseRepo }),
      ...(teamId === undefined ? {} : { teamId }),
      ...(releasePublicKey === undefined ? {} : { releasePublicKey }),
    }),
    platform: 'node',
    format: 'esm',
    target: 'node24',
    bundle: true,
    alias: { 'react-devtools-core': `${repoRoot}scripts/empty-module.ts` },
    plugins: [
      {
        name: 'journal-thread-generated-module',
        setup: (build) => {
          build.onResolve({ filter: /(^|\/)journal-thread-code\.generated(\.ts)?$/ }, () => ({ path: generatedModule }));
        },
      },
      {
        name: 'ata-validator-without-native-and-code-from-strings',
        setup: (build) => {
          const inAta = (importer: string): boolean => importer.includes('/node_modules/ata-validator/');
          build.onResolve({ filter: /(^|\/)native-load(\.js)?$/ }, (args) => (inAta(args.importer) ? { path: `${repoRoot}scripts/ata-no-native.ts` } : undefined));
          build.onResolve({ filter: /(^|\/)compile-fn(\.js)?$/ }, (args) => (inAta(args.importer) ? { path: `${repoRoot}scripts/ata-no-code-from-strings.ts` } : undefined));
        },
      },
    ],
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __momongaCreateRequire } from 'node:module'; const require = __momongaCreateRequire(import.meta.url);",
      ].join('\n'),
    },
  });
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      entry: { type: 'string', default: defaultEntry },
      outfile: { type: 'string', default: defaultOutfile },
      repo: { type: 'string' },
      'team-id': { type: 'string' },
      'release-public-key': { type: 'string' },
      'journal-thread': { type: 'boolean', default: false },
    },
  });
  if (values['journal-thread']) await writeJournalThreadModule();
  else {
    await bundle({
      entry: values.entry,
      outfile: values.outfile,
      ...(values.repo === undefined ? {} : { releaseRepo: values.repo }),
      ...(values['team-id'] === undefined ? {} : { teamId: values['team-id'] }),
      ...(values['release-public-key'] === undefined ? {} : { releasePublicKey: values['release-public-key'] }),
    });
  }
}
