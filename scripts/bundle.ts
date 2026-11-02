import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const defaultEntry = `${repoRoot}packages/cli/src/main.ts`;
export const defaultOutfile = `${repoRoot}packages/cli/dist/main.js`;

export type BundleOptions = {
  readonly entry: string;
  readonly outfile: string;
};

export const bundle = async ({ entry, outfile }: BundleOptions): Promise<void> => {
  await build({
    entryPoints: [entry],
    outfile,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    bundle: true,
    alias: { 'react-devtools-core': `${repoRoot}scripts/empty-module.ts` },
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
    },
  });
  await bundle({ entry: values.entry, outfile: values.outfile });
}
