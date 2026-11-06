import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileCredentialStore, ensureMomongaDirs, momongaLayout } from '@momonga/foundation';
import { mcpCredentialDirectory } from '@momonga/mcp';
import { makeDir } from './mcp-harness.ts';

describe('file credential store under the real path layout', () => {
  it('keeps owner-only files in the per-user state directory of a temporary home and survives a new instance', async () => {
    const home = makeDir();
    const paths = momongaLayout(home);
    await ensureMomongaDirs(paths);
    const directory = mcpCredentialDirectory(paths);
    expect(directory).toBe(path.join(home, '.momonga', 'state', 'mcp-credentials'));
    await createFileCredentialStore(directory).write('server|tokens', '{"access_token":"fake"}');

    expect(await createFileCredentialStore(directory).read('server|tokens')).toBe('{"access_token":"fake"}');
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.state).mode & 0o777).toBe(0o700);
    const [file] = fs.readdirSync(directory);
    expect(fs.statSync(path.join(directory, file as string)).mode & 0o777).toBe(0o600);
    expect(directory.startsWith(fs.realpathSync(home))).toBe(true);
  });
});
