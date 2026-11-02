import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundle, defaultEntry, repoRoot } from './bundle.ts';
import type { UpdateSourceInputs } from './bundle.ts';
import { SEA_TARGETS, ensureSeaNode, isSeaTargetName } from './node-runtime.ts';
import type { SeaTargetName } from './node-runtime.ts';
import { buildZ3Assets } from './z3-assets.ts';

export const nodeCacheDir = `${repoRoot}.cache/node`;
export const entitlementsPath = `${repoRoot}scripts/sea-entitlements.plist`;

export type SeaOptions = UpdateSourceInputs & {
  readonly entry: string;
  readonly output: string;
  readonly workDir: string;
  readonly target?: SeaTargetName;
};

export const buildSeaUnsigned = async ({ entry, output, workDir, target = 'darwin-arm64', releaseRepo, teamId, releasePublicKey }: SeaOptions): Promise<void> => {
  const nodeBinary = await ensureSeaNode(nodeCacheDir, target);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const main = path.join(workDir, 'main.mjs');
  await bundle({
    entry,
    outfile: main,
    ...(releaseRepo === undefined ? {} : { releaseRepo }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(releasePublicKey === undefined ? {} : { releasePublicKey }),
  });
  const assets = await buildZ3Assets(workDir, import.meta.url);
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
      assets,
    }),
  );
  const runner = target === hostSeaTarget() ? nodeBinary : await ensureSeaNode(nodeCacheDir, hostSeaTarget());
  execFileSync(runner, ['--build-sea', configPath], { stdio: 'inherit' });
};

export const hostSeaTarget = (platform: NodeJS.Platform = process.platform, arch: string = process.arch): SeaTargetName => {
  const name = `${platform === 'win32' ? 'win' : platform}-${arch}`;
  if (!isSeaTargetName(name)) throw new Error(`no pinned node runtime for the build host ${platform}/${arch}`);
  return name;
};

export const signAdHoc = (binary: string): void => {
  execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', '--options', 'runtime', '--entitlements', entitlementsPath, binary], {
    stdio: 'inherit',
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binary], { stdio: 'inherit' });
};

export const buildSea = async (options: SeaOptions): Promise<void> => {
  await buildSeaUnsigned(options);
  if ((options.target ?? 'darwin-arm64') === 'darwin-arm64') signAdHoc(options.output);
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      entry: { type: 'string', default: defaultEntry },
      output: { type: 'string', default: `${repoRoot}dist/sea/momonga` },
      'work-dir': { type: 'string', default: `${repoRoot}dist/sea/work` },
      unsigned: { type: 'boolean', default: false },
      target: { type: 'string', default: 'darwin-arm64' },
      repo: { type: 'string' },
      'team-id': { type: 'string' },
      'release-public-key': { type: 'string' },
    },
  });
  if (!isSeaTargetName(values.target)) throw new Error(`unknown --target ${values.target}; expected one of ${Object.keys(SEA_TARGETS).join(', ')}`);
  const options = {
    entry: values.entry,
    output: values.output,
    workDir: values['work-dir'],
    target: values.target,
    ...(values.repo === undefined ? {} : { releaseRepo: values.repo }),
    ...(values['team-id'] === undefined ? {} : { teamId: values['team-id'] }),
    ...(values['release-public-key'] === undefined ? {} : { releasePublicKey: values['release-public-key'] }),
  };
  if (values.unsigned) await buildSeaUnsigned(options);
  else await buildSea(options);
}
