import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createE2eHome } from '../e2e/support/home.ts';
import { spawnPty } from '../e2e/support/pty.ts';
import { bundle, defaultEntry } from './bundle.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-bundle-interactive-'));

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('the interactive entry of the single-file bundle', () => {
  it(
    'draws its first frame on a terminal',
    async () => {
      const outfile = path.join(scratch, 'main.js');
      await bundle({ entry: defaultEntry, outfile, journalThreadModule: path.join(scratch, 'journal-thread-code.generated.ts'), ruleVerifierThreadModule: path.join(scratch, 'rule-verifier-thread-code.generated.ts') });
      const home = await createE2eHome({ run: randomBytes(2).toString('hex') });

      const pty = await spawnPty(home, [], {}, { bundle: outfile });

      await pty.waitFor('Do you trust the files in');
      expect(pty.screen()).not.toContain('unsettled top-level await');
    },
    UNBOUNDED_BUILD_WAIT_MS,
  );
});
