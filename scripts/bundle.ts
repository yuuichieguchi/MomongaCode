import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import type { BuildOptions, Metafile, Plugin } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO_PATTERN, RELEASE_PUBLIC_KEY_PATTERN, TEAM_ID_PATTERN } from '../packages/cli/src/update/source.ts';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const defaultEntry = `${repoRoot}packages/cli/src/main.ts`;
export const defaultOutfile = `${repoRoot}packages/cli/dist/main.js`;
export const journalThreadEntry = `${repoRoot}packages/runtime/src/memory/journal-thread.ts`;
export const journalThreadModule = `${repoRoot}packages/runtime/src/memory/journal-thread-code.generated.ts`;

export const ruleVerifierThreadEntry = `${repoRoot}packages/runtime/src/process/rule-verifier-thread.ts`;
export const ruleVerifierThreadModule = `${repoRoot}packages/runtime/src/process/rule-verifier-thread-code.generated.ts`;

export const storeWorkerEntry = `${repoRoot}packages/gateway/src/core/store-worker.ts`;
export const storeWorkerModule = `${repoRoot}packages/gateway/src/core/store-worker-code.generated.ts`;

export type UpdateSourceInputs = {
  readonly releaseRepo?: string;
  readonly teamId?: string;
  readonly releasePublicKey?: string;
};

export type BundleOptions = UpdateSourceInputs & {
  readonly entry: string;
  readonly outfile: string;
  readonly journalThreadModule?: string;
  readonly ruleVerifierThreadModule?: string;
  readonly storeWorkerModule?: string;
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

export const autoModeDatasetFile = `${repoRoot}packages/eval/datasets/auto-mode.json`;
export const contextDatasetFile = `${repoRoot}packages/eval/datasets/context.json`;

const bundlePlugins: Plugin[] = [
  {
    name: 'auto-mode-dataset-embedded',
    setup: (build) => {
      build.onLoad({ filter: /[\\/]packages[\\/]config[\\/]src[\\/]auto-mode-dataset\.ts$/ }, () => ({
        contents: [
          `export const AUTO_MODE_DATASET_TEXT = ${JSON.stringify(fs.readFileSync(autoModeDatasetFile, 'utf8'))};`,
          `export const CONTEXT_DATASET_TEXT = ${JSON.stringify(fs.readFileSync(contextDatasetFile, 'utf8'))};`,
          '',
        ].join('\n'),
        loader: 'ts',
      }));
    },
  },
  {
    name: 'ata-validator-without-native-and-code-from-strings',
    setup: (build) => {
      const inAta = (importer: string): boolean => importer.includes('/packages/ata-validator/');
      build.onResolve({ filter: /(^|\/)native-load(\.js)?$/ }, (args) => (inAta(args.importer) ? { path: `${repoRoot}scripts/ata-no-native.ts` } : undefined));
      build.onResolve({ filter: /(^|\/)compile-fn(\.js)?$/ }, (args) => (inAta(args.importer) ? { path: `${repoRoot}scripts/ata-no-code-from-strings.ts` } : undefined));
    },
  },
];

export const bundleThreadOf = async (name: string, entry: string): Promise<string> => {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: repoRoot,
    write: false,
    outdir: `${repoRoot}.cache/${name}-out`,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    bundle: true,
    legalComments: 'eof',
    plugins: bundlePlugins,
    logLevel: 'error',
  });
  const [output, ...rest] = result.outputFiles;
  if (output === undefined || rest.length > 0) throw new Error(`${name.replaceAll('-', ' ')} bundle produced ${result.outputFiles.length} files, expected 1`);
  return output.text;
};

const writeThreadModule = (modulePath: string, constant: string, code: string): void => {
  const temporary = path.join(path.dirname(modulePath), `.${path.basename(modulePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `export const ${constant} = ${JSON.stringify(code)};\n`);
    fs.renameSync(temporary, modulePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
};

export const bundleJournalThread = (): Promise<string> => bundleThreadOf('journal-thread', journalThreadEntry);

export const writeJournalThreadModule = async (modulePath: string = journalThreadModule): Promise<void> => {
  writeThreadModule(modulePath, 'JOURNAL_THREAD_CODE', await bundleJournalThread());
};

export const bundleRuleVerifierThread = (): Promise<string> => bundleThreadOf('rule-verifier-thread', ruleVerifierThreadEntry);

export const writeRuleVerifierThreadModule = async (modulePath: string = ruleVerifierThreadModule): Promise<void> => {
  writeThreadModule(modulePath, 'RULE_VERIFIER_THREAD_CODE', await bundleRuleVerifierThread());
};

export const bundleStoreWorker = (): Promise<string> => bundleThreadOf('store-worker', storeWorkerEntry);

export const writeStoreWorkerModule = async (modulePath: string = storeWorkerModule): Promise<void> => {
  writeThreadModule(modulePath, 'STORE_WORKER_CODE', await bundleStoreWorker());
};

export const writeThreadModules = async (): Promise<void> => {
  await writeJournalThreadModule();
  await writeRuleVerifierThreadModule();
  await writeStoreWorkerModule();
};

const bundleBuildOptions = ({
  entry,
  releaseRepo,
  teamId,
  releasePublicKey,
  journalThreadModule: generatedModule = journalThreadModule,
  ruleVerifierThreadModule: generatedVerifierModule = ruleVerifierThreadModule,
  storeWorkerModule: generatedStoreModule = storeWorkerModule,
}: Omit<BundleOptions, 'outfile'>): BuildOptions => ({
  entryPoints: [entry],
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
    ...bundlePlugins,
    {
      name: 'journal-thread-generated-module',
      setup: (build) => {
        build.onResolve({ filter: /(^|\/)journal-thread-code\.generated(\.ts)?$/ }, () => ({ path: generatedModule }));
        build.onResolve({ filter: /(^|\/)rule-verifier-thread-code\.generated(\.ts)?$/ }, () => ({ path: generatedVerifierModule }));
        build.onResolve({ filter: /(^|\/)store-worker-code\.generated(\.ts)?$/ }, () => ({ path: generatedStoreModule }));
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

export const bundle = async (options: BundleOptions): Promise<void> => {
  await writeJournalThreadModule(options.journalThreadModule ?? journalThreadModule);
  await writeRuleVerifierThreadModule(options.ruleVerifierThreadModule ?? ruleVerifierThreadModule);
  await writeStoreWorkerModule(options.storeWorkerModule ?? storeWorkerModule);
  await build({ ...bundleBuildOptions(options), outfile: options.outfile });
};

export type BundleInputs = Metafile['inputs'];

export const bundleInputsOf = async (entry: string): Promise<BundleInputs> => {
  const result = await build({ ...bundleBuildOptions({ entry }), absWorkingDir: repoRoot, outfile: `${repoRoot}.cache/bundle-inputs/main.js`, write: false, metafile: true, logLevel: 'error' });
  return result.metafile.inputs;
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      entry: { type: 'string', default: defaultEntry },
      outfile: { type: 'string', default: defaultOutfile },
      repo: { type: 'string' },
      'team-id': { type: 'string' },
      'release-public-key': { type: 'string' },
      threads: { type: 'boolean', default: false },
    },
  });
  if (values.threads) await writeThreadModules();
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
