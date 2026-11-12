import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir, productTestEnv } from '@momonga/testkit';
import { spawnSync } from '@momonga/testkit/child-process';
import { createE2eHome } from '../e2e/support/home.ts';
import { spawnPty } from '../e2e/support/pty.ts';
import { bundle, defaultEntry } from './bundle.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';

const scratch = createTempDir();
const outfile = path.join(scratch, 'main.js');

beforeAll(async () => {
  await bundle({ entry: defaultEntry, outfile, journalThreadModule: path.join(scratch, 'journal-thread-code.generated.ts'), ruleVerifierThreadModule: path.join(scratch, 'rule-verifier-thread-code.generated.ts') });
}, UNBOUNDED_BUILD_WAIT_MS);

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('the start of the single-file bundle', () => {
  it('draws the first frame of the interactive entry on a terminal', async () => {
    const home = await createE2eHome();

    const pty = await spawnPty(home, [], {}, { bundle: outfile });

    await pty.waitFor('Do you trust the files in');
    expect(pty.screen()).not.toContain('unsettled top-level await');
  });

  it.for(['--version', '--help'])('answers %s without touching a home that cannot be created', (flag) => {
    const blocker = path.join(scratch, `not-a-directory${flag}`);
    fs.writeFileSync(blocker, '');
    const home = path.join(blocker, 'home');

    const result = spawnSync(process.execPath, [outfile, flag], { cwd: scratch, env: productTestEnv({ HOME: home, TMPDIR: scratch, LANG: 'C' }), encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe('');
    expect(fs.statSync(blocker).isFile()).toBe(true);
  });
});
