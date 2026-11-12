import { execFile, execFileSync, spawnSync } from '@momonga/testkit/child-process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

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

  it('refuses a release key that is not one ssh-ed25519 public key line, and names a tampered download in the words of install.sh', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("if ($publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$') { Fail 'the release signing key is not one ssh-ed25519 public key line (ssh-ed25519 AAAA...), so it cannot verify the release; nothing was installed' }");
    expect(source).toContain('does not match the SHA-256 that $checksumsName records (expected $expected, got $actual); nothing was installed');
  });

  it('declares the release repository yuuichieguchi/MomongaCode right after the embedded release public key', () => {
    const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n').map((line) => line.trim());
    const keyLine = lines.indexOf("$embeddedReleasePublicKey = ''");
    expect(keyLine).toBeGreaterThanOrEqual(0);
    expect(lines[keyLine + 1]).toBe("$embeddedReleaseRepo = 'yuuichieguchi/MomongaCode'");
  });

  it('embeds the same release repository as install.sh', () => {
    const shell = /^readonly EMBEDDED_RELEASE_REPO="([^"\n]*)"$/m.exec(fs.readFileSync(`${repoRoot}scripts/install.sh`, 'utf8'))?.[1];
    const powershell = /^\s*\$embeddedReleaseRepo = '([^'\n]*)'$/m.exec(fs.readFileSync(SCRIPT, 'utf8'))?.[1];
    expect(shell).toBe('yuuichieguchi/MomongaCode');
    expect(powershell).toBe(shell);
  });

  it('builds the download URL from the embedded repository, with MOMONGA_REPO only as an override', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).not.toContain('if (-not $env:MOMONGA_REPO)');
    expect(source.match(/\$embeddedReleaseRepo\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const urlLines = source.split('\n').filter((line) => line.includes('https://github.com/'));
    expect(urlLines.length).toBe(2);
    for (const line of urlLines) expect(line).not.toContain('$env:MOMONGA_REPO');
  });

  it('refuses plain http to anything but the loopback interface', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("-notmatch '^https://'");
    expect(source).toContain('(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?(/|$)');
  });

  it('reads SHA256SUMS by the rule of install.sh: one leading * marks binary mode and is removed from the name', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("($fields[1] -replace '^\\*', '') -eq $assetName");
    expect(source).not.toContain("TrimStart('*')");
    expect(fs.readFileSync(`${repoRoot}scripts/install.sh`, 'utf8')).toContain('sub(/^\\*/, "", name)');
  });

  it('moves a running momonga.exe aside as a .momonga-update. entry before it moves the new one in, puts it back if the move in fails, and names the remedy when the move aside is refused', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).not.toContain('Move-Item -Force -LiteralPath $candidate -Destination $target');
    const aside = source.indexOf("'.momonga-update.'");
    const moveIn = source.indexOf('Move-Item -LiteralPath $candidate -Destination $target');
    expect(aside).toBeGreaterThan(-1);
    expect(moveIn).toBeGreaterThan(aside);
    expect(source).toContain('Move-Item -LiteralPath $aside -Destination $target');
    expect(source).toContain('stop the daemon, then run the command again');
  });

  it('writes beside the aside the empty lock database the update sweep claims, so that sweep removes the aside on every lock form', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const aside = source.indexOf('Move-Item -LiteralPath $target -Destination $aside');
    const sidecar = source.indexOf("New-Item -ItemType File -Path ($aside + '.sqlite')");
    expect(sidecar).toBeGreaterThan(-1);
    expect(sidecar).toBeGreaterThan(aside);
  });

  it('runs the candidate with --version before it is moved into place, and refuses another version than the one asked for', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const check = source.indexOf('$reported = & $candidate --version');
    const move = source.indexOf('Move-Item -LiteralPath $candidate -Destination $target');
    expect(check).toBeGreaterThan(0);
    expect(move).toBeGreaterThan(check);
    expect(source).toContain('version $($env:MOMONGA_VERSION) was asked for, but the downloaded executable reports version $reported; nothing was installed');
    expect(source).toContain('the downloaded executable exited with code $LASTEXITCODE for --version; nothing was installed');
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

const TLS12 = '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12';

describe('install.ps1 under irm | iex', () => {
  const source = (): string => fs.readFileSync(SCRIPT, 'utf8');
  const meaningfulLines = (): string[] => source().split(/\r?\n/).filter((line) => line.trim() !== '');

  it('runs its whole body inside one script block invoked with &, so nothing it defines or sets stays in the caller session', () => {
    const lines = meaningfulLines();
    expect(lines[0]).toBe('& {');
    expect(lines[lines.length - 1]).toBe('}');
  });

  it('sets the error preference and defines its functions only inside that script block', () => {
    const lines = source().split(/\r?\n/);
    const preference = lines.filter((line) => line.includes("$ErrorActionPreference = 'Stop'"));
    expect(preference).toHaveLength(1);
    expect(preference[0]).toMatch(/^\s+\$ErrorActionPreference = 'Stop'$/);
    const definitions = lines.filter((line) => /^\s*function\s/.test(line));
    expect(definitions.length).toBeGreaterThanOrEqual(3);
    for (const line of definitions) expect(line).toMatch(/^\s+function\s/);
    expect(source()).not.toMatch(/\$(global|script):/i);
    expect(source()).not.toMatch(/^\s*exit\b/m);
  });

  it('adds TLS 1.2 to the enabled protocols with a bitwise or, without replacing them', () => {
    const lines = source().split(/\r?\n/).map((line) => line.trim());
    expect(lines.filter((line) => line === TLS12)).toHaveLength(1);
    expect(source().match(/SecurityProtocol\s*=/g)?.length ?? 0).toBe(1);
  });

  it('adds TLS 1.2 before the first download', () => {
    const tls = source().indexOf(TLS12);
    const firstDownload = source().search(/Invoke-WebRequest|Invoke-RestMethod/);
    expect(tls).toBeGreaterThanOrEqual(0);
    expect(firstDownload).toBeGreaterThan(tls);
  });
});

describe.runIf(pwshAvailable)('install.ps1 under iex in a caller session', () => {
  it('leaves no function, variable or preference of its own in the caller scope', () => {
    const probe = [
      "$ErrorActionPreference = 'Continue'",
      `$text = Get-Content -Raw -LiteralPath '${SCRIPT}'`,
      'try { Invoke-Expression $text } catch { }',
      "foreach ($name in 'Fail', 'Read-UserPath', 'Write-UserPath') { if (Get-Command $name -ErrorAction SilentlyContinue) { Write-Output \"leaked function $name\" } }",
      "foreach ($name in 'assetName', 'embeddedReleaseRepo', 'prefix') { if (Get-Variable -Name $name -Scope Global -ErrorAction SilentlyContinue) { Write-Output \"leaked variable $name\" } }",
      'Write-Output "preference $ErrorActionPreference"',
    ].join('; ');
    const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], PROCESSOR_ARCHITECTURE: 'x86' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout.split(/\r?\n/).filter((line) => line !== '')).toEqual(['preference Continue']);
  });
});

const READ_USER_PATH = "function Read-UserPath { [Environment]::GetEnvironmentVariable('Path', 'User') }";
const CANDIDATE_CHECK = '$reported = & $candidate --version';
const WRITE_USER_PATH = "function Write-UserPath([string]$value) { [Environment]::SetEnvironmentVariable('Path', $value, 'User') }";

describe('install.ps1 PATH contract', () => {
  const source = (): string => fs.readFileSync(SCRIPT, 'utf8');

  it('reads and writes the PATH through one user-scope reader and one user-scope writer', () => {
    const lines = source().split('\n').map((line) => line.trim());
    expect(lines.filter((line) => line === READ_USER_PATH)).toHaveLength(1);
    expect(lines.filter((line) => line === WRITE_USER_PATH)).toHaveLength(1);
    expect(source().match(/SetEnvironmentVariable/g)?.length ?? 0).toBe(1);
    expect(source().match(/GetEnvironmentVariable/g)?.length ?? 0).toBe(1);
    expect(source()).not.toMatch(/'Machine'|"Machine"|EnvironmentVariableTarget\]::Machine/);
  });

  it('calls the writer only from a branch that MOMONGA_MODIFY_PATH=0 turns off', () => {
    expect(source()).toContain("$env:MOMONGA_MODIFY_PATH -ne '0'");
    expect(source().match(/\bWrite-UserPath\b/g)?.length ?? 0).toBe(2);
  });

  it('prints the command for the open PowerShell session', () => {
    expect(source()).toContain('`$env:Path = "$prefix;`$env:Path"');
  });
});

const ASSET = 'momonga-win-x64.exe';
const BINARY = Buffer.from('momonga-windows-binary\n');
const NAMESPACE = 'momonga-release';

describe.runIf(pwshAvailable)('install.ps1 PATH behaviour under PowerShell', () => {
  let root = '';
  let server: http.Server;
  let served: Record<string, Buffer> = {};
  let baseUrl = '';
  let publicKey = '';

  beforeAll(async () => {
    root = createTempRoot();
    const privateKey = path.join(root, 'release_key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release_key', '-f', privateKey]);
    publicKey = fs.readFileSync(`${privateKey}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
    const sums = Buffer.from(`${createHash('sha256').update(BINARY).digest('hex')}  ${ASSET}\n`);
    const sumsFile = path.join(root, 'SHA256SUMS');
    fs.writeFileSync(sumsFile, sums);
    execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', privateKey, '-n', NAMESPACE, sumsFile]);
    served = { [`/${ASSET}`]: BINARY, '/SHA256SUMS': sums, '/SHA256SUMS.sig': fs.readFileSync(`${sumsFile}.sig`) };
    server = http.createServer((request, response) => {
      const body = served[request.url ?? ''];
      if (body === undefined) return void response.writeHead(404).end();
      response.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await removeTempRoot(root);
  });

  type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

  const stubbedInstaller = (userPathFile: string): string => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    expect(text).toContain(READ_USER_PATH);
    expect(text).toContain(WRITE_USER_PATH);
    expect(text).toContain(CANDIDATE_CHECK);
    const directory = fs.mkdtempSync(path.join(root, 'stubbed-'));
    const script = path.join(directory, 'install.ps1');
    fs.writeFileSync(
      script,
      text
        .replace(READ_USER_PATH, `function Read-UserPath { Get-Content -Raw -LiteralPath '${userPathFile}' }`)
        .replace(WRITE_USER_PATH, `function Write-UserPath([string]$value) { Set-Content -NoNewline -LiteralPath '${userPathFile}' -Value $value }`)
        .replace(CANDIDATE_CHECK, "$reported = '1.0.0'; $global:LASTEXITCODE = 0"),
    );
    return script;
  };

  const install = (script: string, prefix: string, extra: NodeJS.ProcessEnv = {}): Promise<Run> =>
    new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'],
        HOME: root,
        PROCESSOR_ARCHITECTURE: 'AMD64',
        MOMONGA_INSTALL_PREFIX: prefix,
        MOMONGA_RELEASE_BASE_URL: baseUrl,
        MOMONGA_RELEASE_PUBLIC_KEY: publicKey,
        ...extra,
      };
      execFile('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { env }, (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
        reject(error);
      });
    });

  const setup = (initialUserPath: string): { prefix: string; userPathFile: string; script: string } => {
    const prefix = fs.mkdtempSync(path.join(root, 'prefix-'));
    const userPathFile = path.join(root, `user-path-${path.basename(prefix)}`);
    fs.writeFileSync(userPathFile, initialUserPath);
    return { prefix, userPathFile, script: stubbedInstaller(userPathFile) };
  };

  const openShellLine = (prefix: string): string => `$env:Path = "${prefix};$env:Path"`;

  it('adds the directory to the user PATH once, and prints the command and the changed setting', async () => {
    const { prefix, userPathFile, script } = setup('C:\\Tools;C:\\Other');
    const first = await install(script, prefix);
    expect(first.code).toBe(0);
    expect(fs.readFileSync(userPathFile, 'utf8')).toBe(`C:\\Tools;C:\\Other;${prefix}`);
    const lines = first.stdout.split(/\r?\n/);
    expect(lines.filter((line) => line.trim() === openShellLine(prefix))).toHaveLength(1);
    expect(first.stdout).toContain('user PATH');
    const second = await install(script, prefix);
    expect(second.code).toBe(0);
    expect(fs.readFileSync(userPathFile, 'utf8')).toBe(`C:\\Tools;C:\\Other;${prefix}`);
  });

  it('changes nothing with MOMONGA_MODIFY_PATH=0 and still prints the command', async () => {
    const { prefix, userPathFile, script } = setup('C:\\Tools');
    const run = await install(script, prefix, { MOMONGA_MODIFY_PATH: '0' });
    expect(run.code).toBe(0);
    expect(fs.readFileSync(userPathFile, 'utf8')).toBe('C:\\Tools');
    expect(run.stdout.split(/\r?\n/).filter((line) => line.trim() === openShellLine(prefix))).toHaveLength(1);
  });
});
