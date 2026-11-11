import { describe, expect, it } from 'vitest';
import { ShellNotFoundError, resolveBashPath } from '../src/bash-path.ts';

const portsWith = (existing: string[], path = ''): Parameters<typeof resolveBashPath>[1] => ({ isExecutable: (file) => existing.includes(file), env: { Path: path } });

describe('resolveBashPath', () => {
  it('uses /bin/bash on darwin without probing', () => {
    expect(resolveBashPath('darwin', portsWith([]))).toBe('/bin/bash');
  });

  it('prefers /bin/bash and then /usr/bin/bash on linux', () => {
    expect(resolveBashPath('linux', portsWith(['/bin/bash', '/usr/bin/bash']))).toBe('/bin/bash');
    expect(resolveBashPath('linux', portsWith(['/usr/bin/bash']))).toBe('/usr/bin/bash');
  });

  it('fails on linux without bash', () => {
    expect(() => resolveBashPath('linux', portsWith([]))).toThrow(ShellNotFoundError);
  });

  it('finds Git for Windows bash from git.exe in cmd or mingw64\\bin on PATH', () => {
    const root = 'C:\\Program Files\\Git';
    expect(resolveBashPath('win32', portsWith([`${root}\\cmd\\git.exe`, `${root}\\bin\\bash.exe`], `C:\\Windows;${root}\\cmd`))).toBe(`${root}\\bin\\bash.exe`);
    expect(resolveBashPath('win32', portsWith([`${root}\\mingw64\\bin\\git.exe`, `${root}\\bin\\bash.exe`], `${root}\\mingw64\\bin`))).toBe(`${root}\\bin\\bash.exe`);
  });

  it('fails on windows when git.exe is absent or has no bash beside it', () => {
    expect(() => resolveBashPath('win32', portsWith([], 'C:\\Windows'))).toThrow('Git for Windows');
    expect(() => resolveBashPath('win32', portsWith(['C:\\g\\cmd\\git.exe'], 'C:\\g\\cmd'))).toThrow('Git for Windows');
  });
});
