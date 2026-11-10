import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_SECRET_PROGRAMS_ENV, installFakeSecretPrograms } from '@momonga/testkit';

export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'momonga-secret-programs-'));
  const bin = installFakeSecretPrograms(root);
  process.env[TEST_SECRET_PROGRAMS_ENV] = bin;
  process.env['PATH'] = `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`;
  return () => fs.rmSync(root, { recursive: true, force: true });
}
