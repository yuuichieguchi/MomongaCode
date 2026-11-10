import path from 'node:path';
import { TEST_SECRET_PROGRAMS_ENV, createFakeSecretPrograms, removeFakeSecretPrograms } from '@momonga/testkit';

export default function setup(): () => void {
  const { root, bin } = createFakeSecretPrograms();
  process.env[TEST_SECRET_PROGRAMS_ENV] = bin;
  process.env['PATH'] = `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`;
  return () => removeFakeSecretPrograms(root);
}
