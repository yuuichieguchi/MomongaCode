import path from 'node:path';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { createBubblewrapSandbox, createPlaceholderJournal } from '@momonga/sandbox';

const KILL_GRACE_MS = 300;

const [work, tmpRoot, journalDirectory, bwrap, killAt] = process.argv.slice(2) as [string, string, string, string, 'before-intend' | 'before-complete' | 'after-complete'];

const inner = createPlaceholderJournal(journalDirectory);
const killSelf = (): never => {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('still alive after SIGKILL');
};

const sandbox = createBubblewrapSandbox({
  bwrapPath: bwrap,
  tmpRoot,
  killGraceMs: KILL_GRACE_MS,
  holders: () => new Set(),
  journal: {
    intend: (target, intentMs) => {
      if (killAt === 'before-intend') killSelf();
      inner.intend(target, intentMs);
    },
    complete: (target, identity) => {
      if (killAt === 'before-complete') killSelf();
      inner.complete(target, identity);
      if (killAt === 'after-complete') killSelf();
    },
    forget: (target) => inner.forget(target),
    records: () => inner.records(),
  },
});

sandbox.spawn(
  { argv: ['/bin/sh', '-c', 'sleep 5'], cwd: work, env: { PATH: '/usr/bin:/bin' } },
  {
    writableRoots: [work],
    writeDenied: [path.join(work, '.mcp.json')],
    writeDeniedLiterals: [],
    protectedSet: EMPTY_PROTECTED_SET,
    fileRules: EMPTY_FILE_RULES,
    readDenied: [],
    network: 'deny',
  },
  new AbortController().signal,
);
