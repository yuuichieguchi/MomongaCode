import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTlaJar } from './fetch-tla.ts';
import { SEA_TARGETS, archiveNameOf, ensureSeaNode, nodeArchiveCacheDir } from './node-runtime.ts';
import type { SeaTargetName } from './node-runtime.ts';
import { RIPGREP_TARGETS, ensureRipgrepArchive, ripgrepCacheDir } from './ripgrep-release.ts';

export type TestSetupStep = { readonly provides: readonly string[]; readonly run: () => Promise<unknown> };

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export const testSetupSteps = (root: string): TestSetupStep[] => [
  {
    provides: ['bun'],
    run: async () => execFileSync(NPM, ['ci', '--no-audit', '--no-fund', '--prefix', path.join(root, 'compliance', 'open-responses')], { stdio: 'inherit' }),
  },
  { provides: ['tla2tools.jar'], run: async () => fetchTlaJar(root, process.env) },
  ...(Object.keys(SEA_TARGETS) as SeaTargetName[]).map((target) => ({ provides: [archiveNameOf(SEA_TARGETS[target])], run: () => ensureSeaNode(nodeArchiveCacheDir, target) })),
  ...(Object.keys(RIPGREP_TARGETS) as SeaTargetName[]).map((target) => ({ provides: [RIPGREP_TARGETS[target].archiveName], run: () => ensureRipgrepArchive(ripgrepCacheDir, target) })),
];

if (import.meta.main) {
  for (const step of testSetupSteps(fileURLToPath(new URL('..', import.meta.url)))) {
    await step.run();
    process.stdout.write(`provided ${step.provides.join(', ')}\n`);
  }
}
