import { createFakeSecretPrograms, posixPathLine, removeFakeSecretPrograms } from '../packages/testkit/src/fake-secret-programs.ts';

const USAGE =
  'usage: node scripts/fake-secret-programs.ts install | node scripts/fake-secret-programs.ts remove <directory> <token>; install prints the directory, a PATH line for a POSIX shell and the token that remove requires';

type Output = { out(text: string): void; err(text: string): void };

export const runFakeSecretPrograms = (argv: readonly string[], platform: NodeJS.Platform, output: Output): number => {
  const [command, directory, token] = argv;
  try {
    if (platform === 'win32') throw new Error('no fake secret store program that the product can start exists for Windows yet.');
    if (command === 'install' && directory === undefined) {
      const created = createFakeSecretPrograms();
      output.out(`${created.root}\n${posixPathLine(created.bin)}\n${created.token}\n`);
    } else if (command === 'remove' && directory !== undefined && token !== undefined) {
      removeFakeSecretPrograms(directory, token);
    } else {
      throw new Error(USAGE);
    }
    return 0;
  } catch (error) {
    output.err(`fake-secret-programs.ts: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = runFakeSecretPrograms(process.argv.slice(2), process.platform, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
