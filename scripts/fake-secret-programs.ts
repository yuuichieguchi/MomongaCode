import { createFakePrograms, posixEnvLine, removeFakePrograms } from '../packages/testkit/src/fake-programs.ts';

const USAGE =
  'usage: node scripts/fake-secret-programs.ts install | node scripts/fake-secret-programs.ts remove <directory> <token>; install puts the fake secret store programs and the stand-ins for the programs that open a URL in a fresh directory and prints the directory, one line for a POSIX shell that sets PATH and BROWSER, and the token that remove requires';

type Output = { out(text: string): void; err(text: string): void };

export const runFakeSecretPrograms = (argv: readonly string[], platform: NodeJS.Platform, output: Output): number => {
  const [command, directory, token] = argv;
  try {
    if (platform === 'win32') throw new Error('no fake secret store program that the product can start exists for Windows yet.');
    if (command === 'install' && directory === undefined) {
      const created = createFakePrograms();
      output.out(`${created.root}\n${posixEnvLine(created.bin)}\n${created.token}\n`);
    } else if (command === 'remove' && directory !== undefined && token !== undefined) {
      removeFakePrograms(directory, token);
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
