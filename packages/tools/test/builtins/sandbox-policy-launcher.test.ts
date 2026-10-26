import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alwaysWriteDenied } from '@momonga/sandbox';
import { withTempDir } from '@momonga/testkit';
import { buildSandboxPolicy } from '@momonga/tools';

describe('buildSandboxPolicy consumes alwaysWriteDenied', () => {
  it('carries the subtrees in writeDenied and the literals in writeDeniedLiterals', (context) => {
    const home = withTempDir(context);
    fs.mkdirSync(path.join(home, 'dotfiles', 'local', 'bin'), { recursive: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'local'), path.join(home, '.local'));
    const policy = buildSandboxPolicy({ roots: [home], home, tmpDir: path.join(home, 's', 'one'), sessionsTmpRoot: path.join(home, 's') });
    const denied = alwaysWriteDenied(home);
    expect(policy.writeDenied).toEqual(expect.arrayContaining([...denied.subtrees]));
    expect([...new Set(policy.writeDeniedLiterals)].sort()).toEqual(
      [path.join(home, '.local', 'bin', 'momonga'), path.join(home, 'dotfiles', 'local', 'bin', 'momonga')].sort(),
    );
  });
});
