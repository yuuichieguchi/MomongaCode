import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO_PATTERN, RELEASE_PUBLIC_KEY_PATTERN, TEAM_ID_PATTERN } from '../packages/cli/src/update/source.ts';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const defaultEntry = `${repoRoot}packages/cli/src/main.ts`;
export const defaultOutfile = `${repoRoot}packages/cli/dist/main.js`;

export type UpdateSourceInputs = {
  readonly releaseRepo?: string;
  readonly teamId?: string;
  readonly releasePublicKey?: string;
};

export type BundleOptions = UpdateSourceInputs & {
  readonly entry: string;
  readonly outfile: string;
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

export const bundle = async ({ entry, outfile, releaseRepo, teamId, releasePublicKey }: BundleOptions): Promise<void> => {
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
        name: 'ata-validator-without-native-and-code-from-strings',
        setup: (build) => {
          build.onResolve({ filter: /(^|\/)(native-load|compile-fn)(\.js)?$/ }, (args) =>
            args.importer.includes('/node_modules/ata-validator/') ? { path: `${repoRoot}scripts/empty-module.ts` } : undefined,
          );
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
    },
  });
  await bundle({
    entry: values.entry,
    outfile: values.outfile,
    ...(values.repo === undefined ? {} : { releaseRepo: values.repo }),
    ...(values['team-id'] === undefined ? {} : { teamId: values['team-id'] }),
    ...(values['release-public-key'] === undefined ? {} : { releasePublicKey: values['release-public-key'] }),
  });
}
