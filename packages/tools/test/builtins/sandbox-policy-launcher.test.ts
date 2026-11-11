import fs from 'node:fs';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, momongaLayout } from '@momonga/foundation';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alwaysWriteDenied } from '@momonga/sandbox';
import { withTempDir, NEVER_CANCELLED } from '@momonga/testkit';
import { buildSandboxPolicy } from '@momonga/tools';

describe('buildSandboxPolicy consumes alwaysWriteDenied', () => {
  it('carries the subtrees in writeDenied and the literals in writeDeniedLiterals', async (context) => {
    const home = withTempDir(context);
    fs.mkdirSync(path.join(home, 'dotfiles', 'local', 'bin'), { recursive: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'local'), path.join(home, '.local'));
    const policy = await buildSandboxPolicy({ layout: momongaLayout(home, process.platform, process.env), protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [home], home, tmpDir: path.join(home, 's', 'one'), sessionsTmpRoot: path.join(home, 's') }, NEVER_CANCELLED);
    const denied = await alwaysWriteDenied(momongaLayout(home, process.platform, process.env), NEVER_CANCELLED);
    expect(policy.writeDenied).toEqual(expect.arrayContaining([...denied.subtrees]));
    expect([...new Set(policy.writeDeniedLiterals)].sort()).toEqual(
      [path.join(home, '.local', 'bin', 'momonga'), path.join(home, 'dotfiles', 'local', 'bin', 'momonga')].sort(),
    );
  });
});
