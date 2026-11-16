import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempRoot, removeTempRoot } from '../scripts/support/temp.ts';
import { WINDOWS_KEEPER_SOURCE, WindowsCompilerMissingError, compileWindowsProgram } from '../scripts/windows-keeper.ts';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

describe('the compiler of the Windows keeper', () => {
  it('is reported missing by name, with the way to install it, when zig is not on PATH', () => {
    const root = createTempRoot();
    roots.push(root);
    const emptyBin = path.join(root, 'bin');
    fs.mkdirSync(emptyBin);
    vi.stubEnv('PATH', emptyBin);

    const attempt = (): void => compileWindowsProgram(WINDOWS_KEEPER_SOURCE, path.join(root, 'out', 'keeper.exe'), 'x86_64-windows-gnu');

    expect(attempt).toThrow(WindowsCompilerMissingError);
    expect(attempt).toThrow(/zig was not found on PATH.*install zig/);
  });

  it('passes on a failure of the compiler that is not a missing compiler', () => {
    const root = createTempRoot();
    roots.push(root);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'zig'), '#!/bin/sh\necho "planted compile error" >&2\nexit 3\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`);

    const attempt = (): void => compileWindowsProgram(WINDOWS_KEEPER_SOURCE, path.join(root, 'out', 'keeper.exe'), 'x86_64-windows-gnu');

    expect(attempt).toThrow();
    expect(attempt).not.toThrow(WindowsCompilerMissingError);
  });
});
