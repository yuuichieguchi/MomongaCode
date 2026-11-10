import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { releaseTargetOf } from '@momonga/foundation';
import type { ReleaseTargetName } from '@momonga/foundation';
import { extractCommand } from '../../scripts/node-runtime.ts';
import { RIPGREP_TARGETS, RIPGREP_VERSION, ensureRipgrepArchive, hasExecutableFormat, ripgrepCacheDir } from '../../scripts/ripgrep-release.ts';

const hostTarget = (): ReleaseTargetName => {
  const target = releaseTargetOf(process.platform, process.arch);
  if (target === undefined) throw new Error(`the pinned ripgrep ${RIPGREP_VERSION} has no release for ${process.platform}-${process.arch}`);
  return target;
};

export const pinnedRipgrepPath = (): string => path.join(ripgrepCacheDir, ...RIPGREP_TARGETS[hostTarget()].memberPath.split('/'));

const pinnedVersionLine = new RegExp(`^ripgrep ${RIPGREP_VERSION.replaceAll('.', '\\.')}( |$)`);

const isPinnedRipgrep = (target: ReleaseTargetName, binary: string): boolean =>
  fs.existsSync(binary) &&
  fs.lstatSync(binary).isFile() &&
  hasExecutableFormat(target, fs.readFileSync(binary)) &&
  pinnedVersionLine.test(execFileSync(binary, ['--version'], { encoding: 'utf8' }).split('\n')[0] as string);

export const ensurePinnedRipgrep = async (): Promise<string> => {
  const target = hostTarget();
  const row = RIPGREP_TARGETS[target];
  const binary = pinnedRipgrepPath();
  if (isPinnedRipgrep(target, binary)) return binary;
  const archive = await ensureRipgrepArchive(ripgrepCacheDir, target).catch((error: unknown) => {
    throw new Error(`the tests need the pinned ripgrep ${RIPGREP_VERSION} archive ${row.archiveName} in ${ripgrepCacheDir}, and it is missing and could not be fetched`, { cause: error });
  });
  fs.rmSync(path.join(ripgrepCacheDir, path.posix.dirname(row.memberPath)), { recursive: true, force: true });
  const { file, args } = extractCommand(row, archive, ripgrepCacheDir, process.platform, process.env);
  execFileSync(file, [...args]);
  if (!isPinnedRipgrep(target, binary)) throw new Error(`${row.memberPath} extracted from ${row.archiveName} is not a ${row.format} executable reporting ripgrep ${RIPGREP_VERSION}`);
  return binary;
};

export default async function setup(): Promise<void> {
  await ensurePinnedRipgrep();
}
