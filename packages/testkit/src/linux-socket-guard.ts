import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '@momonga/foundation';
import { execFileSync } from './child-process.ts';

const REPOSITORY = path.resolve(import.meta.dirname, '..', '..', '..');
const BUILD_SCRIPT = path.join(REPOSITORY, 'scripts', 'linux-socket-guard.ts');
const SOURCE = path.join(REPOSITORY, 'native', 'linux-socket-guard', 'guard.c');
const BUILT = path.join(REPOSITORY, '.cache', 'linux-socket-guard-host');
const WORK_NAME_BYTES = 8;

const builtFromSource = (): string => {
  const guard = path.join(BUILT, sha256Hex(fs.readFileSync(SOURCE)).slice(0, 16), 'momonga-socket-guard');
  if (fs.existsSync(guard)) return guard;
  const work = path.join(BUILT, `work-${randomBytes(WORK_NAME_BYTES).toString('hex')}`);
  try {
    const binary = execFileSync(process.execPath, [BUILD_SCRIPT, '--work-dir', work, '--compiler', 'host'], { encoding: 'utf8' }).trim();
    fs.mkdirSync(path.dirname(guard), { recursive: true });
    fs.renameSync(binary, guard);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return guard;
};

export const hostBuiltSocketGuard = (): (() => string) => {
  let built: string | undefined;
  return () => {
    built ??= builtFromSource();
    return built;
  };
};
