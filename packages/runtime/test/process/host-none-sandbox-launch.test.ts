import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { momongaLayout, protectedAreasOf } from '@momonga/foundation';
import { createTempDir } from '@momonga/testkit';
import { hostNoneSandboxLaunch } from '@momonga/runtime';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the host launch of a child outside the command sandbox', () => {
  it.runIf(process.platform === 'darwin')('denies the areas of the canonical home when the home is reached through a link', async () => {
    const root = createTempDir();
    roots.push(root);
    const real = path.join(root, 'real-home');
    fs.mkdirSync(real);
    const linked = path.join(root, 'linked-home');
    fs.symlinkSync(real, linked);
    const launch = await hostNoneSandboxLaunch({ home: linked, platform: 'darwin', env: {} }, new AbortController().signal);
    expect(launch.protection).toEqual({ kind: 'home-denied', home: fs.realpathSync(real), denied: protectedAreasOf(momongaLayout(fs.realpathSync(real), 'darwin', {})) });
  });
});
