import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}packages/cli/src/main.ts`],
  outfile: `${root}packages/cli/dist/main.js`,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  bundle: true,
  alias: { 'react-devtools-core': `${root}scripts/empty-module.ts` },
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __momongaCreateRequire } from 'node:module'; const require = __momongaCreateRequire(import.meta.url);",
    ].join('\n'),
  },
});
