import { describe, expect, it } from 'vitest';
import { ShellNotFoundError, resolveBashPath, resolveBashPathNow } from '../src/bash-path.ts';

const portsWith = (existing: string[], path = ''): Parameters<typeof resolveBashPath>[1] => ({ isExecutable: (file) => existing.includes(file), env: { Path: path } });

describe('resolveBashPath', () => {
  it('uses /bin/bash on darwin without probing', async () => {
    expect(await resolveBashPath('darwin', portsWith([]))).toBe('/bin/bash');
  });

  it('prefers /bin/bash and then /usr/bin/bash on linux', async () => {
    expect(await resolveBashPath('linux', portsWith(['/bin/bash', '/usr/bin/bash']))).toBe('/bin/bash');
    expect(await resolveBashPath('linux', portsWith(['/usr/bin/bash']))).toBe('/usr/bin/bash');
  });

  it('fails on linux without bash', async () => {
    await expect(resolveBashPath('linux', portsWith([]))).rejects.toThrow(ShellNotFoundError);
  });

  it('finds Git for Windows bash from git.exe in cmd or mingw64\\bin on PATH', async () => {
    const root = 'C:\\Program Files\\Git';
    expect(await resolveBashPath('win32', portsWith([`${root}\\cmd\\git.exe`, `${root}\\bin\\bash.exe`], `C:\\Windows;${root}\\cmd`))).toBe(`${root}\\bin\\bash.exe`);
    expect(await resolveBashPath('win32', portsWith([`${root}\\mingw64\\bin\\git.exe`, `${root}\\bin\\bash.exe`], `${root}\\mingw64\\bin`))).toBe(`${root}\\bin\\bash.exe`);
  });

  it('fails on windows when git.exe is absent or has no bash beside it', async () => {
    await expect(resolveBashPath('win32', portsWith([], 'C:\\Windows'))).rejects.toThrow('Git for Windows');
    await expect(resolveBashPath('win32', portsWith(['C:\\g\\cmd\\git.exe'], 'C:\\g\\cmd'))).rejects.toThrow('Git for Windows');
  });

  it('answers the same through the synchronous driver of the one rule', () => {
    const root = 'C:\\Program Files\\Git';
    const windows = { isExecutable: (file: string) => [`${root}\\cmd\\git.exe`, `${root}\\bin\\bash.exe`].includes(file), env: { Path: `C:\\Windows;${root}\\cmd` } };
    expect(resolveBashPathNow('win32', windows)).toBe(`${root}\\bin\\bash.exe`);
    expect(resolveBashPathNow('linux', { isExecutable: (file) => file === '/usr/bin/bash', env: {} })).toBe('/usr/bin/bash');
    expect(resolveBashPathNow('darwin', { isExecutable: () => false, env: {} })).toBe('/bin/bash');
    expect(() => resolveBashPathNow('linux', { isExecutable: () => false, env: {} })).toThrow(ShellNotFoundError);
  });
});
