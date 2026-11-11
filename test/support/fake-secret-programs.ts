import path from 'node:path';
import { TEST_SECRET_PROGRAMS_ENV, createFakePrograms, fakeBrowserOf, removeFakePrograms } from '@momonga/testkit';

export default function setup(): () => void {
  const { root, bin, token } = createFakePrograms();
  process.env[TEST_SECRET_PROGRAMS_ENV] = bin;
  process.env['PATH'] = `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`;
  process.env['BROWSER'] = fakeBrowserOf(bin);
  return () => removeFakePrograms(root, token);
}
