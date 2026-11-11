import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileCredentialStore, ensureMomongaDirs, momongaLayout } from '@momonga/foundation';
import { mcpCredentialDirectory } from '@momonga/mcp';
import { withTempDir, testKernelLock } from '@momonga/testkit';

describe('file credential store under the real path layout', () => {
  it('keeps owner-only files in the per-user state directory of a temporary home and survives a new instance', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaLayout(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const directory = mcpCredentialDirectory(paths);
    const signal = new AbortController().signal;
    expect(directory).toBe(path.join(home, '.momonga', 'state', 'mcp-credentials'));
    await createFileCredentialStore(directory, { lock: testKernelLock() }).write('server|tokens', '{"access_token":"fake"}', signal);

    expect(await createFileCredentialStore(directory, { lock: testKernelLock() }).read('server|tokens', signal)).toBe('{"access_token":"fake"}');
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.state).mode & 0o777).toBe(0o700);
    const [file] = fs.readdirSync(directory);
    expect(fs.statSync(path.join(directory, file as string)).mode & 0o777).toBe(0o600);
    expect(directory.startsWith(fs.realpathSync(home))).toBe(true);
  });
});
