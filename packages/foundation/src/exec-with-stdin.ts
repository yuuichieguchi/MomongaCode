import { nodeCommandRunner } from './platform/command-runner.ts';
import type { SecretProcessPort } from './secret-store.ts';

export { ProgramSignalledError } from './platform/command-runner.ts';

export const createExecWithStdin =
  (env: Readonly<Record<string, string>> | undefined): SecretProcessPort =>
  (file, args, stdin, signal) =>
    nodeCommandRunner(file, args, { env, input: stdin, signal });
