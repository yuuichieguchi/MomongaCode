import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCK_PROOF_ENV, LOCK_PROOF_PREFIX } from '@momonga/testkit';

export default function setup(): () => void {
  const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), LOCK_PROOF_PREFIX));
  process.env[LOCK_PROOF_ENV] = folder;
  return () => {
    fs.rmSync(folder, { recursive: true, force: true });
  };
}
