import type { ChildLaunch } from '@momonga/foundation';

export const TEST_UNPROTECTED_LAUNCH: ChildLaunch = {
  protection: { kind: 'unprotected', reason: 'a test child runs without the protection of the home' },
  commandOf: ([file, ...args]) => {
    if (file === undefined) throw new Error('argv must not be empty');
    return { file, args };
  },
};
