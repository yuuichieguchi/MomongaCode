import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPathResolver, momongaPaths, nodeFileSystem } from '@momonga/foundation';
import { noneSandboxLaunchOf } from '@momonga/sandbox';
import { createTempDir } from '@momonga/testkit';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the launch of a managed model server from a home reached through a link', () => {
  it.runIf(process.platform === 'darwin')('denies the real directory of the home under seatbelt (macOS)', async () => {
    const root = fs.realpathSync(createTempDir());
    roots.push(root);
    const real = path.join(root, 'real-home');
    const linked = path.join(root, 'linked-home');
    fs.mkdirSync(real);
    fs.symlinkSync(real, linked);
    const secret = path.join(momongaPaths(real, 'darwin', {}).root, 'secret.txt');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, 'kept\n');
    const launch = await noneSandboxLaunchOf({ home: linked, platform: 'darwin', env: {}, paths: createPathResolver(nodeFileSystem, new AbortController().signal), isUsableBinary: async () => false });
    const command = launch.commandOf(['/bin/cat', secret], []);
    const read = spawnSync(command.file, command.args, { encoding: 'utf8' });
    expect(read.stdout).not.toContain('kept');
    expect(read.status).not.toBe(0);
  });
});
