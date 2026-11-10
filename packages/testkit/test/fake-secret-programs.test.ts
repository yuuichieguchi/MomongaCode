import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_STORE_SEARCHED_PROGRAMS, createExecWithStdin, createSecretServiceStore, findProgramOnPath } from '@momonga/foundation';
import { fakeSecretProgramsBin, installFakeSecretPrograms } from '@momonga/testkit';

const roots: string[] = [];
const freshRoot = (): string => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fake-secret-programs-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';

describe('installFakeSecretPrograms', () => {
  it.each(SECRET_STORE_SEARCHED_PROGRAMS)('installs a fake %s that the PATH lookup of this host finds in the fake directory', (program) => {
    const bin = installFakeSecretPrograms(freshRoot());
    expect(findProgramOnPath(program, { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` })).toBe(path.join(bin, program));
  });

  it.each(SECRET_STORE_SEARCHED_PROGRAMS)('installs a fake %s.cmd that a simulated Windows PATHEXT lookup resolves in the fake directory; starting it is not verified on a Windows host', (program) => {
    const bin = installFakeSecretPrograms(freshRoot(), 'win32');
    const found = findProgramOnPath(program, { PATH: bin, PATHEXT: WINDOWS_PATHEXT });
    expect(found).toBe(path.join(bin, `${program}.cmd`));
    expect(fs.readFileSync(found as string, 'utf8')).toContain(JSON.stringify(process.execPath).slice(1, -1));
  });

  it('the fake secret-tool of the run keeps what it stores and looks it up like the Secret Service', async () => {
    const bin = fakeSecretProgramsBin();
    const store = createSecretServiceStore(createExecWithStdin({ PATH: '/usr/bin:/bin' }), path.join(bin, 'secret-tool'));
    await store.write(`isolation-${process.pid}`, 'stored value', new AbortController().signal);
    await expect(store.read(`isolation-${process.pid}`, new AbortController().signal)).resolves.toBe('stored value');
  });

  it('the fake cmdkey of the run, which has no protocol fake, refuses every call loudly', () => {
    const bin = fakeSecretProgramsBin();
    let failure: { status: number | null; stderr: string } | undefined;
    try {
      execFileSync(path.join(bin, 'cmdkey'), ['/list'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failure = error as { status: number | null; stderr: string };
    }
    expect(failure?.status).not.toBe(0);
    expect(failure?.stderr).toMatch(/fake cmdkey: no fake of this program's protocol exists/);
  });
});
