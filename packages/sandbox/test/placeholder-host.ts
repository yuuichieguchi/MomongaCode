import path from 'node:path';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { createBubblewrapSandbox, createPlaceholderJournal, heldMountPoints } from '@momonga/sandbox';

const KILL_GRACE_MS = 300;
const KEEP_ALIVE_MS = 1000;

const [work, tmpRoot, journalDirectory, control] = process.argv.slice(2) as [string, string, string, string];

const sandbox = createBubblewrapSandbox({ tmpRoot, killGraceMs: KILL_GRACE_MS, journal: createPlaceholderJournal(journalDirectory), holders: () => heldMountPoints() });

sandbox.spawn(
  { argv: ['/bin/sh', '-c', `: > ${control}/ready; cat ${control}/gate > /dev/null`], cwd: work, env: { PATH: '/usr/bin:/bin' } },
  {
    writableRoots: [work, control],
    writeDenied: [],
    writeDeniedLiterals: [path.join(work, '.mcp.json'), path.join(work, '.envrc')],
    protectedSet: EMPTY_PROTECTED_SET,
    fileRules: EMPTY_FILE_RULES,
    readDenied: [],
    network: 'deny',
  },
  new AbortController().signal,
);

setInterval(() => undefined, KEEP_ALIVE_MS);
