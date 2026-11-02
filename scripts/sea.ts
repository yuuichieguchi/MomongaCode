import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundle, defaultEntry, repoRoot } from './bundle.ts';
import { ensureSeaNode } from './node-runtime.ts';

export const nodeCacheDir = `${repoRoot}.cache/node`;
export const entitlementsPath = `${repoRoot}scripts/sea-entitlements.plist`;

export type SeaOptions = {
  readonly entry: string;
  readonly output: string;
  readonly workDir: string;
};

export const buildSeaUnsigned = async ({ entry, output, workDir }: SeaOptions): Promise<void> => {
  const nodeBinary = await ensureSeaNode(nodeCacheDir);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const main = path.join(workDir, 'main.mjs');
  await bundle({ entry, outfile: main });
  const configPath = path.join(workDir, 'sea-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      main,
      mainFormat: 'module',
      executable: nodeBinary,
      output,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      execArgvExtension: 'none',
    }),
  );
  execFileSync(nodeBinary, ['--build-sea', configPath], { stdio: 'inherit' });
};

export const signAdHoc = (binary: string): void => {
  execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', '--options', 'runtime', '--entitlements', entitlementsPath, binary], {
    stdio: 'inherit',
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binary], { stdio: 'inherit' });
};

export const buildSea = async (options: SeaOptions): Promise<void> => {
  await buildSeaUnsigned(options);
  signAdHoc(options.output);
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      entry: { type: 'string', default: defaultEntry },
      output: { type: 'string', default: `${repoRoot}dist/sea/momonga` },
      'work-dir': { type: 'string', default: `${repoRoot}dist/sea/work` },
      unsigned: { type: 'boolean', default: false },
    },
  });
  const options = { entry: values.entry, output: values.output, workDir: values['work-dir'] };
  if (values.unsigned) await buildSeaUnsigned(options);
  else await buildSea(options);
}
