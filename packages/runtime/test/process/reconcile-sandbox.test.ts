import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import * as runtime from '@momonga/runtime';
import { createPolicyFilesystem } from '@momonga/tools';
import { inertSandbox, makeTempHome, signalNever } from './helpers.ts';

describe('the sandbox of a Git reconcile', () => {
  it('is built by the builder of the normal path from the roots of the session, without the session tmp dir as a root', async () => {
    const temp = await makeTempHome();
    const tmpDir = path.join(temp.paths.tmp.sessions, 'session-1');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const reconcileSandbox = runtime.createReconcileSandbox({
      paths: temp.paths,
      home: temp.home,
      sandboxes: runtime.fixedSandboxBindings(inertSandbox),
      fs: createPolicyFilesystem(),
    });
    const project = fs.realpathSync(temp.project);

    const held = await reconcileSandbox({
      idemKey: 'key-1',
      clock: createFakeClock(0),
      deadlineAt: Number.MAX_SAFE_INTEGER,
      signal: signalNever(),
      roots: [project, fs.realpathSync(tmpDir)],
      tmpDir: fs.realpathSync(tmpDir),
      random: systemRandom,
      files: nodeFileSystem,
    });
    held.release();

    expect(held.sandboxPolicy.writableRoots).toContain(project);
    expect(held.sandboxPolicy.protectedSet).toBeDefined();
  });
});
