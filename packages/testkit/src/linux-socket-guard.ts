import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from './child-process.ts';
import { tempDirPrefixFor, testRunToken } from './test-support.ts';

const BUILD_SCRIPT = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'linux-socket-guard.ts');

export const hostBuiltSocketGuard = (): (() => string) => {
  let built: string | undefined;
  return () => {
    built ??= execFileSync(process.execPath, [BUILD_SCRIPT, '--work-dir', fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefixFor(testRunToken()))), '--compiler', 'host'], { encoding: 'utf8' }).trim();
    return built;
  };
};
