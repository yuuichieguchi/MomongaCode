import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';

const SCRIPT = `${repoRoot}scripts/install.ps1`;

const doubleQuotedStrings = (source: string): string[] => [...source.matchAll(/"((?:[^"`]|`.)*)"/g)].map((match) => match[1] as string);

const VARIABLE_FOLLOWED_BY_COLON = /\$(?:env:)?[A-Za-z_]\w*:(?![:\w])/;

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
const pwshAvailable = pwsh.error === undefined && pwsh.status === 0;

describe('install.ps1', () => {
  it('never puts a colon directly after a variable name inside a double-quoted string, where PowerShell reads it as a scope or drive qualifier', () => {
    const offenders = doubleQuotedStrings(fs.readFileSync(SCRIPT, 'utf8')).filter((text) => VARIABLE_FOLLOWED_BY_COLON.test(text));
    expect(offenders).toEqual([]);
  });

  it('detects the hazard it guards against', () => {
    expect(VARIABLE_FOLLOWED_BY_COLON.test('unsupported architecture $env:PROCESSOR_ARCHITECTURE: only x64')).toBe(true);
    expect(VARIABLE_FOLLOWED_BY_COLON.test('unsupported architecture ${env:PROCESSOR_ARCHITECTURE}: only x64')).toBe(false);
    expect(VARIABLE_FOLLOWED_BY_COLON.test('path $env:LOCALAPPDATA')).toBe(false);
  });

  it('fails clearly, and says what to do, when no release key is pinned', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("$embeddedReleasePublicKey = ''");
    expect(source).toContain('this installer pins no release signing key');
    expect(source).toContain('set MOMONGA_RELEASE_PUBLIC_KEY to the ssh public key line the maintainers publish');
  });

  it('refuses plain http to anything but the loopback interface', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("-notmatch '^https://'");
    expect(source).toContain('(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?(/|$)');
  });

  it.runIf(pwshAvailable)('parses without errors under PowerShell', () => {
    const parse = spawnSync(
      'pwsh',
      ['-NoProfile', '-Command', `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$null, [ref]$errors) | Out-Null; $errors | ForEach-Object { $_.Message }; exit $errors.Count`],
      { encoding: 'utf8' },
    );
    expect(parse.stdout).toBe('');
    expect(parse.status).toBe(0);
  });
});
