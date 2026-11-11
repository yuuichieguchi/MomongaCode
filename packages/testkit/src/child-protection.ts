import type { ChildProtection } from '@momonga/foundation';

export const TEST_CHILD_UNPROTECTED: ChildProtection = { kind: 'unprotected', reason: 'a test child runs without the protection of the home' };

export const TEST_STDIO_LAUNCH = {
  protection: TEST_CHILD_UNPROTECTED,
  commandOf: (argv: readonly string[]): { file: string; args: string[] } => {
    const [file, ...args] = argv;
    if (file === undefined) throw new Error('argv must not be empty');
    return { file, args };
  },
};
