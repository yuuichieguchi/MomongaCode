import fs from 'node:fs';
import { createTempDir, LOCK_PROOF_ENV } from '@momonga/testkit';

export default function setup(): () => void {
  const folder = createTempDir();
  process.env[LOCK_PROOF_ENV] = folder;
  return () => {
    fs.rmSync(folder, { recursive: true, force: true });
  };
}
