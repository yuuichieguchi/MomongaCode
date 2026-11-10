import path from 'node:path';
import { createFakeSecretPrograms, removeFakeSecretPrograms } from '../packages/testkit/src/fake-secret-programs.ts';

const USAGE = 'usage: node scripts/fake-secret-programs.ts install | node scripts/fake-secret-programs.ts remove <directory>';

if (import.meta.main) {
  const [command, directory] = process.argv.slice(2);
  try {
    if (command === 'install' && directory === undefined) {
      const { root, bin } = createFakeSecretPrograms();
      process.stdout.write(`${root}\nPATH=${bin}${path.delimiter}$PATH\n`);
    } else if (command === 'remove' && directory !== undefined) {
      removeFakeSecretPrograms(directory);
    } else {
      throw new Error(USAGE);
    }
  } catch (error) {
    process.stderr.write(`fake-secret-programs.ts: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
